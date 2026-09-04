/**
 * In-memory SQLite driver for tests.
 *
 * Implements exactly the statement surface the local-storage layer uses
 * (kv, outbox, cache): CREATE TABLE, INSERT (+ OR IGNORE / ON CONFLICT
 * DO UPDATE), UPDATE, DELETE (incl. LIKE, <=, NOT IN (subselect)),
 * SELECT (projection, WHERE, ORDER BY, LIMIT, GROUP BY + COUNT(*)).
 * Unknown statements throw, so a change to the SQL in the db layer
 * surfaces as a loud test failure, not a silent mismatch.
 *
 * Parameters bind strictly left-to-right across each statement, like real
 * SQLite: SET params first for UPDATE, then WHERE params; WHERE params then
 * LIMIT ? for SELECT/DELETE. Subselects receive their own parameters.
 */
import type { SqliteHandle } from '@/db/database';

type Row = Record<string, unknown>;

interface TableDef {
  columns: string[];
  primaryKey: string[];
  rows: Row[];
}

/** Tuple of `count` captured strings (keeps destructuring non-optional). */
type CaptureTuple<N extends number> = N extends 1
  ? [string]
  : N extends 2
    ? [string, string]
    : N extends 3
      ? [string, string, string]
      : N extends 4
        ? [string, string, string, string]
        : string[];

/** Regex captures with a loud failure instead of `undefined` leakage. */
function groups<const N extends number>(match: RegExpMatchArray, count: N): CaptureTuple<N> {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = match[index + 1];
    if (typeof value !== 'string') throw new Error(`InMemorySqlite: missing regex capture ${index + 1} in: ${match.input}`);
    out.push(value);
  }
  return out as CaptureTuple<N>;
}

/** Split on `separator` at paren depth 0 only. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && text.startsWith(separator, index)) {
      parts.push(current);
      current = '';
      index += separator.length;
      continue;
    }
    current += char;
    index += 1;
  }
  parts.push(current);
  return parts;
}

function like(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export class InMemorySqlite implements SqliteHandle {
  private tables = new Map<string, TableDef>();
  private version = 0;

  /** Clear every row but keep table definitions (re-init stays cheap). */
  reset(): void {
    for (const table of this.tables.values()) table.rows = [];
    this.version = 0;
  }

  execSync(sql: string): void {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('CREATE TABLE')) {
      const createMatch = compact.match(/^CREATE TABLE (?:IF NOT EXISTS )?(\w+) \((.*)\)$/);
      if (!createMatch) throw new Error(`InMemorySqlite: bad CREATE TABLE: ${sql}`);
      const [name, body] = groups(createMatch, 2);
      if (this.tables.has(name)) return;
      const def: TableDef = { columns: [], primaryKey: [], rows: [] };
      for (const item of splitTopLevel(body, ',')) {
        const trimmed = item.trim();
        if (/^PRIMARY KEY \(/.test(trimmed)) {
          def.primaryKey = trimmed
            .replace(/^PRIMARY KEY \(/, '')
            .replace(/\)$/, '')
            .split(',')
            .map((c) => c.trim());
        } else if (/^(PRIMARY KEY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)/.test(trimmed)) {
          continue;
        } else {
          const column = trimmed.split(/\s+/)[0] ?? '';
          if (!column) throw new Error(`InMemorySqlite: bad column item: ${trimmed}`);
          def.columns.push(column);
          if (/\bPRIMARY KEY\b/.test(trimmed)) def.primaryKey = [column];
        }
      }
      this.tables.set(name, def);
      return;
    }
    if (compact.startsWith('CREATE INDEX') || compact.startsWith('CREATE UNIQUE INDEX')) return;
    const versionMatch = compact.match(/^PRAGMA user_version = (\d+)$/);
    if (versionMatch) {
      this.version = Number(groups(versionMatch, 1)[0]);
      return;
    }
    if (compact.startsWith('PRAGMA')) return;
    if (compact.startsWith('DELETE FROM')) {
      this.handleDelete(compact, []);
      return;
    }
    throw new Error(`InMemorySqlite: unsupported exec: ${sql}`);
  }

  runSync(sql: string, params: unknown[] = []): { changes: number } {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('INSERT')) return this.handleInsert(compact, params);
    if (compact.startsWith('UPDATE')) return this.handleUpdate(compact, params);
    if (compact.startsWith('DELETE')) return this.handleDelete(compact, params);
    if (compact.startsWith('PRAGMA')) return { changes: 0 };
    throw new Error(`InMemorySqlite: unsupported run: ${sql}`);
  }

  getAllSync<T = Row>(sql: string, params: unknown[] = []): T[] {
    return this.handleSelect(sql.replace(/\s+/g, ' ').trim(), params) as T[];
  }

  getFirstSync<T = Row>(sql: string, params: unknown[] = []): T | null {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('PRAGMA user_version')) {
      return { user_version: this.version } as unknown as T;
    }
    const rows = this.handleSelect(compact, params);
    return (rows[0] as T) ?? null;
  }

  // --- internals ---------------------------------------------------------------

  private table(name: string): TableDef {
    let table = this.tables.get(name);
    if (!table) {
      table = { columns: [], primaryKey: [], rows: [] };
      this.tables.set(name, table);
    }
    return table;
  }

  private handleInsert(sql: string, params: unknown[]): { changes: number } {
    const match = sql.match(/^INSERT (?:OR IGNORE )?INTO (\w+) \(([^)]+)\) VALUES \(([^)]*)\)(.*)$/);
    if (!match) throw new Error(`InMemorySqlite: bad insert: ${sql}`);
    const [name, columnList, valueList, tail] = groups(match, 4);
    const table = this.table(name);
    const columns = columnList.split(',').map((c) => c.trim());
    const placeholders = valueList.split(',').filter((v) => v.trim().length > 0).length;
    if (placeholders !== columns.length || placeholders !== params.length) {
      throw new Error(`InMemorySqlite: column/placeholder/param mismatch in: ${sql}`);
    }
    const row: Row = {};
    columns.forEach((column, index) => {
      row[column] = params[index];
    });

    const upsert = tail.trim().match(/^ON CONFLICT \(([^)]+)\) DO UPDATE SET (.+)$/);
    if (upsert) {
      const [keyList, updatePart] = groups(upsert, 2);
      const keyColumns = keyList.split(',').map((c) => c.trim());
      const existing = table.rows.find((candidate) => keyColumns.every((key) => candidate[key] === row[key]));
      if (existing) {
        for (const assignment of splitTopLevel(updatePart, ',')) {
          const excluded = assignment.trim().match(/(\w+) = excluded\.(\w+)$/);
          if (excluded) {
            const [target, source] = groups(excluded, 2);
            existing[target] = row[source];
          }
        }
        return { changes: 1 };
      }
      table.rows.push(row);
      return { changes: 1 };
    }

    const conflicts =
      table.primaryKey.length > 0 &&
      table.rows.some((candidate) => table.primaryKey.every((key) => candidate[key] === row[key]));
    if (conflicts) {
      if (sql.includes('OR IGNORE')) return { changes: 0 };
      throw new Error(`InMemorySqlite: unique constraint failed: ${sql}`);
    }
    table.rows.push(row);
    return { changes: 1 };
  }

  private handleUpdate(sql: string, params: unknown[]): { changes: number } {
    const match = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+)$/);
    if (!match) throw new Error(`InMemorySqlite: bad update: ${sql}`);
    const [name, setPart, wherePart] = groups(match, 3);
    const table = this.table(name);

    let cursor = 0;
    const assignments: Array<{ column: string; value: unknown }> = [];
    for (const item of splitTopLevel(setPart, ',')) {
      const trimmed = item.trim();
      const literal = trimmed.match(/(\w+) = NULL$/);
      if (literal) {
        assignments.push({ column: groups(literal, 1)[0]!, value: null });
        continue;
      }
      const text = trimmed.match(/(\w+) = '([^']*)'$/);
      if (text) {
        const [column, value] = groups(text, 2);
        assignments.push({ column, value });
        continue;
      }
      const param = trimmed.match(/(\w+) = \?$/);
      if (param) {
        assignments.push({ column: groups(param, 1)[0]!, value: params[cursor] });
        cursor += 1;
        continue;
      }
      throw new Error(`InMemorySqlite: unsupported SET item: ${item}`);
    }

    const predicate = this.buildPredicate(wherePart, params, cursor);
    let changes = 0;
    for (const row of table.rows) {
      if (predicate.matches(row)) {
        for (const { column, value } of assignments) row[column] = value;
        changes += 1;
      }
    }
    return { changes };
  }

  private handleDelete(sql: string, params: unknown[]): { changes: number } {
    const match = sql.match(/^DELETE FROM (\w+)(?: WHERE (.+))?$/);
    if (!match) throw new Error(`InMemorySqlite: bad delete: ${sql}`);
    const [name, wherePart] = groups(match, 2);
    const table = this.table(name);
    if (!wherePart) {
      const before = table.rows.length;
      table.rows = [];
      return { changes: before };
    }
    const predicate = this.buildPredicate(wherePart, params, 0);
    const before = table.rows.length;
    table.rows = table.rows.filter((row) => !predicate.matches(row));
    return { changes: before - table.rows.length };
  }

  private handleSelect(sql: string, params: unknown[]): Row[] {
    if (!sql.startsWith('SELECT')) throw new Error(`InMemorySqlite: unsupported select: ${sql}`);
    const match = sql.match(/^SELECT (.+?) FROM (\w+)(.*)$/);
    if (!match) throw new Error(`InMemorySqlite: bad select: ${sql}`);
    const [projection, name, tail] = groups(match, 3);
    const table = this.table(name);

    // WHERE
    let rows = [...table.rows];
    const whereMatch = tail.match(/WHERE (.+?)(?= GROUP BY| ORDER BY| LIMIT|$)/);
    if (whereMatch) {
      const predicate = this.buildPredicate(groups(whereMatch, 1)[0]!, params, 0);
      rows = rows.filter((row) => predicate.matches(row));
    }

    // GROUP BY + COUNT(*)
    const groupMatch = tail.match(/GROUP BY (\w+)/);
    if (groupMatch) {
      const groupColumn = groups(groupMatch, 1)[0]!;
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = String(row[groupColumn]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([key, n]) => ({ [groupColumn]: key, n }) as Row);
    }

    // ORDER BY
    const orderMatch = tail.match(/ORDER BY (\w+) (ASC|DESC)/);
    if (orderMatch) {
      const [column, direction] = groups(orderMatch, 2);
      rows.sort((a, b) => {
        const compare = String(a[column] ?? '').localeCompare(String(b[column] ?? ''));
        return direction === 'ASC' ? compare : -compare;
      });
    }

    // LIMIT
    const limitMatch = tail.match(/LIMIT (\d+)/);
    const limitParam = /LIMIT \?$/.test(tail);
    if (limitMatch) {
      rows = rows.slice(0, Number(groups(limitMatch, 1)[0]));
    } else if (limitParam) {
      // The LIMIT ? parameter is the last one consumed in the statement.
      const beforeLimit = tail.slice(0, tail.indexOf('LIMIT'));
      const bound = (beforeLimit.match(/\?/g) ?? []).length;
      rows = rows.slice(0, Number(params[bound]));
    }

    // Projection
    if (projection.trim() === '*') return rows;
    const columns = projection.split(',').map((c) => c.trim());
    return rows.map((row) => {
      const projected: Row = {};
      for (const column of columns) {
        if (/COUNT\(\*\) AS/.test(column)) {
          throw new Error('InMemorySqlite: COUNT(*) outside GROUP BY is unsupported');
        }
        projected[column] = row[column];
      }
      return projected;
    });
  }

  /**
   * Compile a WHERE body into a row predicate. Parameters are consumed
   * strictly left-to-right starting at `cursor` (for UPDATE, SET params come
   * first). Subselects consume their own parameters from the stream.
   */
  private buildPredicate(wherePart: string, params: unknown[], cursorStart: number): { matches: (row: Row) => boolean } {
    let cursor = cursorStart;
    const conditions = splitTopLevel(wherePart, ' AND ').map((c) => c.trim());
    const evaluators = conditions.map((condition): ((row: Row) => boolean) => {
      const param = condition.match(/^(\w+) (=|<=|>=|<|>) \?$/);
      if (param) {
        const [column, operator] = groups(param, 2);
        const value = params[cursor];
        cursor += 1;
        return (row) => compare(row[column], operator, value);
      }
      const literal = condition.match(/^(\w+) = '([^']*)'$/);
      if (literal) {
        const [column, value] = groups(literal, 2);
        return (row) => row[column] === value;
      }
      const likeMatch = condition.match(/^(\w+) LIKE \?$/);
      if (likeMatch) {
        const column = groups(likeMatch, 1)[0]!;
        const value = params[cursor];
        cursor += 1;
        return (row) => like(String(row[column] ?? ''), String(value));
      }
      const notIn = condition.match(/^(\w+) NOT IN \((.+)\)$/);
      if (notIn) {
        const [column, sub] = groups(notIn, 2);
        const subParams = params.slice(cursor, cursor + (sub.match(/\?/g)?.length ?? 0));
        cursor += subParams.length;
        const values = this.handleSelect(sub.trim(), subParams).map((r) => Object.values(r)[0]);
        return (row) => !values.some((v) => v === row[column]);
      }
      throw new Error(`InMemorySqlite: unsupported WHERE condition: ${condition}`);
    });
    return {
      matches: (row) => evaluators.every((evaluate) => evaluate(row)),
    };
  }
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case '=':
      return left === right;
    case '<=':
      return String(left) <= String(right);
    case '>=':
      return String(left) >= String(right);
    case '<':
      return String(left) < String(right);
    case '>':
      return String(left) > String(right);
    default:
      throw new Error(`InMemorySqlite: unsupported operator: ${operator}`);
  }
}

export function newInMemorySqlite(): InMemorySqlite {
  return new InMemorySqlite();
}
