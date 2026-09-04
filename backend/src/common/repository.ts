/**
 * Shared data-access helpers.
 *
 * The one rule worth enforcing centrally: every list/read filters
 * `is_deleted: false` unless a caller explicitly opts out. Forgetting that
 * filter in one handler is how soft-deleted records reappear in the UI.
 */
import type { Collection, Document, Filter, Sort } from 'mongodb';
import type { PaginationMeta } from '@itp/shared';
import { getDb } from '../db/mongo.js';
import { ApiError } from '../core/api-error.js';
import type { Db } from 'mongodb';

/** Get the database or fail with a clean 503 instead of a null dereference. */
export function requireDb(): Db {
  const db = getDb();
  if (!db) {
    throw ApiError.dependencyUnavailable('mongodb');
  }
  return db;
}

/** Add the soft-delete filter unless the caller asked for deleted rows too. */
export function liveFilter<T extends Document>(
  filter: Filter<T> = {},
  includeDeleted = false,
): Filter<T> {
  if (includeDeleted) return filter;
  return { ...filter, is_deleted: false } as Filter<T>;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

/**
 * Run a paginated find.
 *
 * `countDocuments` on the same filter is an extra round trip, but an accurate
 * total is what lets the UI render "page 3 of 7". At MVP data volumes the cost
 * is negligible; if a collection ever gets large, switch that call to an
 * estimate behind this same interface.
 */
export async function paginate<T extends Document>(
  collection: Collection<T>,
  filter: Filter<T>,
  options: {
    page: number;
    limit: number;
    sort: Sort;
    projection?: Document;
    collation?: { locale: string; strength: number };
  },
): Promise<PaginatedResult<T>> {
  const { page, limit, sort, projection, collation } = options;
  const skip = (page - 1) * limit;

  let cursor = collection.find(filter, projection ? { projection } : undefined).sort(sort);
  if (collation) cursor = cursor.collation(collation);

  const [items, total] = await Promise.all([
    cursor.skip(skip).limit(limit).toArray(),
    collection.countDocuments(filter),
  ]);

  return {
    items: items as T[],
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
}

/** Timestamps for a new document. */
export function creationStamps(userId?: import('mongodb').ObjectId | null) {
  const now = new Date();
  return {
    created_at: now,
    updated_at: now,
    schema_version: 1,
    ...(userId !== undefined ? { created_by: userId, updated_by: userId } : {}),
  };
}

/** Timestamps for an update. */
export function updateStamps(userId?: import('mongodb').ObjectId | null) {
  return {
    updated_at: new Date(),
    ...(userId !== undefined ? { updated_by: userId } : {}),
  };
}

/** Soft-delete marker. */
export function deletionStamps(userId: import('mongodb').ObjectId, reason?: string) {
  return {
    is_deleted: true,
    deleted_at: new Date(),
    deleted_by: userId,
    delete_reason: reason ?? null,
    updated_at: new Date(),
  };
}

/**
 * Translate a duplicate-key error into a 409 with a useful message.
 *
 * Relying on the unique index rather than a pre-check avoids the race where
 * two concurrent creates both pass a "does it exist?" query.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

export function duplicateKeyToApiError(error: unknown, fallbackMessage: string): ApiError {
  if (!isDuplicateKeyError(error)) {
    return ApiError.internal('An unexpected database error occurred.', error);
  }

  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern ?? {};
  const fields = Object.keys(keyPattern);

  return new ApiError('CONFLICT', fallbackMessage, {
    details: fields.map((field) => ({
      field,
      issue: 'A record with this value already exists.',
    })),
  });
}
