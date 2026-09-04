/**
 * Bounded in-process background worker for manual processing.
 *
 * No Redis or external broker: this is a single-node deployment with a handful
 * of jobs per hour, and Mongo already holds the job state transactionally with
 * the business data. The upgrade path (BullMQ + Redis) is documented but
 * deliberately not taken.
 *
 * The queue is deliberately small and robust:
 *  - a concurrency cap so OCR/embedding jobs do not saturate the box
 *  - never throws out of `enqueue` - a failure is logged and the job is left
 *    `failed` by the runner, never silently dropped
 *  - jobs survive a process restart via the Mongo job record (a reconciler can
 *    re-enqueue stale `running` jobs - Phase 3 keeps a minimal version of this)
 */

import { getLogger } from '../../core/logger.js';

export type JobTask = () => Promise<void>;

interface QueueEntry {
  task: JobTask;
  label: string;
}

const logger = getLogger();

let activeCount = 0;
const pending: QueueEntry[] = [];
/** Concurrency cap - Ollama embeds serially anyway; more just adds timeouts. */
const MAX_CONCURRENCY = 2;

/** Run the next queued task if a worker slot is free. */
function pump(): void {
  while (activeCount < MAX_CONCURRENCY && pending.length > 0) {
    const entry = pending.shift();
    if (!entry) return;
    activeCount += 1;

    void entry
      .task()
      .catch((error) => {
        // The runner itself must never reject, but if a task does, record it.
        logger.error(
          { err: error instanceof Error ? error.message : String(error), label: entry.label },
          'background_worker_task_failed',
        );
      })
      .finally(() => {
        activeCount -= 1;
        pump();
      });
  }
}

/** Enqueue a job. Returns immediately; the runner executes asynchronously. */
export function enqueue(label: string, task: JobTask): void {
  pending.push({ label, task });
  pump();
}

/** Test-only introspection. */
export function queueSize(): number {
  return pending.length;
}

/** Test-only: run everything synchronously by flushing the queue. */
export async function flushAll(): Promise<void> {
  while (pending.length > 0 || activeCount > 0) {
    if (pending.length === 0) {
      // Give the active task a tick to settle before re-checking.
      await new Promise((resolve) => setImmediate(resolve));
    } else {
      pump();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}
