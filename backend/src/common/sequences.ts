/**
 * Atomic counters for human-readable sequence numbers.
 *
 * `findOneAndUpdate` with `$inc` and `upsert` is atomic in MongoDB, so two
 * concurrent incident creations can never receive the same number. The naive
 * alternative - `count() + 1` - produces duplicates under concurrency and
 * reuses numbers after a delete, both of which are unacceptable for an
 * identifier people quote to each other.
 */
import type { Db } from 'mongodb';

const COUNTERS = 'counters';

interface CounterDoc {
  _id: string;
  value: number;
}

/** Increment and return the next value for `key`. */
export async function nextSequence(db: Db, key: string): Promise<number> {
  const result = await db
    .collection<CounterDoc>(COUNTERS)
    .findOneAndUpdate(
      { _id: key },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );

  if (!result) {
    // Should be unreachable with upsert+returnDocument:'after'.
    throw new Error(`Failed to allocate a sequence number for "${key}".`);
  }
  return result.value;
}

/**
 * Human-facing incident number, e.g. `INC-2026-000042`.
 *
 * Year-scoped so numbers restart annually and stay short, and zero-padded so
 * they sort lexicographically in the same order as numerically.
 */
export async function nextIncidentNumber(db: Db, now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const value = await nextSequence(db, `incident:${year}`);
  return `INC-${year}-${String(value).padStart(6, '0')}`;
}

/**
 * Per-parent sequence for append-only children (incident actions, messages).
 *
 * Scoped by parent id so each incident's actions read 1, 2, 3 rather than
 * sharing a global counter.
 */
export async function nextChildSequence(
  db: Db,
  scope: string,
  parentId: string,
): Promise<number> {
  return nextSequence(db, `${scope}:${parentId}`);
}
