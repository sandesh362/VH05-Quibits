/**
 * Validation helpers built on zod.
 *
 * Two rules drive everything here:
 *  1. Never trust the client. Every id, enum, date, and string length is
 *     checked server-side even though the UI also checks.
 *  2. Nothing reaches a Mongo query unless it passed a schema. This is what
 *     stops operator injection: a body of `{"email": {"$ne": null}}` fails
 *     `z.string()` and never becomes a query fragment.
 */
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_DEFAULT_PAGE,
  PAGINATION_MAX_LIMIT,
  type ApiErrorDetail,
} from '@itp/shared';
import { ApiError } from '../core/api-error.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A 24-character hex ObjectId.
 *
 * Critically this returns a VALIDATION_ERROR rather than letting
 * `new ObjectId(garbage)` throw a BSONError that surfaces as a 500.
 */
export const objectIdSchema = z
  .string()
  .trim()
  .refine((value) => ObjectId.isValid(value) && new ObjectId(value).toHexString() === value, {
    message: 'Must be a valid 24-character hexadecimal id.',
  });

export function toObjectId(value: string): ObjectId {
  return new ObjectId(value);
}

/** Emails are lowercased and trimmed so uniqueness is unambiguous. */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Must be a valid email address.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9._-]+$/, 'Only lowercase letters, digits, dot, underscore and hyphen.');

/** Bounded free text. The cap limits both DoS and, later, prompt size. */
export const boundedText = (min: number, max: number, label = 'Value') =>
  z.string().trim().min(min, `${label} must not be empty.`).max(max, `${label} must be at most ${max} characters.`);

/** Accepts an ISO string or a Date; always yields a Date. */
export const dateSchema = z.coerce.date();

/** A date that cannot be in the future - used for "when did this happen". */
export const pastOrPresentDate = dateSchema.refine((d) => d.getTime() <= Date.now() + 60_000, {
  message: 'The date must not be in the future.',
});

/** Error codes are normalised so `e041`, `E-041 ` and `E041` compare equal. */
export function normaliseErrorCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Part numbers feed later intersection logic; normalise or it silently fails. */
export function normalisePartNumber(raw: string): string {
  return raw.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Pagination and sorting
// ---------------------------------------------------------------------------

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(PAGINATION_DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(PAGINATION_MAX_LIMIT).default(PAGINATION_DEFAULT_LIMIT),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

/**
 * Sort fields come from an allowlist per module.
 *
 * Passing a user-supplied string straight into `.sort()` lets a caller sort by
 * an unindexed field and table-scan the collection, and leaks schema shape
 * through timing. An allowlist removes both.
 */
export function buildSort(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
  allowed: readonly string[],
  fallback: string,
): Record<string, 1 | -1> {
  const field = sortBy && allowed.includes(sortBy) ? sortBy : fallback;
  return { [field]: sortOrder === 'asc' ? 1 : -1 };
}

export function buildPaginationMeta(total: number, page: number, limit: number) {
  return {
    page,
    limit,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

// ---------------------------------------------------------------------------
// Parsing entry points
// ---------------------------------------------------------------------------

function toDetails(error: z.ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    issue: issue.message,
  }));
}

/**
 * Parse or throw a VALIDATION_ERROR carrying field-level detail.
 * The zod error itself never reaches the client.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  message = 'The request contains invalid fields.',
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ApiError.validation(message, toDetails(result.error));
  }
  return result.data;
}

/**
 * Reject payloads containing Mongo operators or prototype-pollution keys.
 *
 * `.strict()` schemas already drop unknown keys, but this runs first as
 * defence in depth and gives a clearer message than "unrecognized key".
 */
export function assertNoOperators(value: unknown, path = 'body'): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOperators(item, `${path}[${index}]`));
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('$')) {
      throw ApiError.validation('The request contains invalid fields.', [
        { field: `${path}.${key}`, issue: 'Field names must not start with "$".' },
      ]);
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw ApiError.validation('The request contains invalid fields.', [
        { field: `${path}.${key}`, issue: 'Reserved field name.' },
      ]);
    }
    if (key.includes('.')) {
      throw ApiError.validation('The request contains invalid fields.', [
        { field: `${path}.${key}`, issue: 'Field names must not contain ".".' },
      ]);
    }
    assertNoOperators(nested, `${path}.${key}`);
  }
}

/**
 * Escape a user string used inside a regex.
 *
 * Without this, a search for `(((((` is a syntax error and `(a+)+$` is a
 * catastrophic-backtracking DoS.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive "contains" matcher for search parameters. */
export function containsMatcher(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}
