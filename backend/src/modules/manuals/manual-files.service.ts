/**
 * Manual file handling: validation, fingerprinting and secure local storage.
 *
 * This module is intentionally free of database and HTTP concerns so it can be
 * unit-tested in isolation. It is where every upload-safety rule lives:
 * extension, MIME, magic bytes, size, empty-file and path-traversal rejection.
 *
 * SECURITY RULES
 *  - The client filename is NEVER used to build a path. It is kept as display
 *    metadata only, sanitised so it can never be mistaken for a path later.
 *  - The stored file uses a server-generated name derived from the manual id.
 *  - Only PDF files are accepted in this phase.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../../core/api-error.js';

/** What the upload endpoint accepts. */
export interface UploadedFileInfo {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  size: number;
}

export interface ValidatedPdf {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

/** MIME type we accept; anything else is rejected with a clear 415. */
export const PDF_MIME_TYPES = ['application/pdf', 'application/x-pdf'];

/**
 * Sanitise an original filename for display/metadata.
 *
 * The result is never used as a path. Still, separators and traversal
 * sequences are stripped so a stored value can never be mistaken for a safe
 * path by later (possibly careless) code, and so the UI cannot be made to
 * render something that looks like a path.
 */
export function sanitizeFilename(raw: string): string {
  // Strip any directory components (both separators, plus Windows drive letter).
  const basenameOnly = raw.replace(/[/\\]/g, '/').split('/').pop() ?? '';
  return basenameOnly
    .replace(/\.\./g, '')
    .replace(/[^\w. -]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
}

/** Accept only filename extensions that resolve to application/pdf. */
export function isPdfExtension(filename: string): boolean {
  return path.extname(filename).toLowerCase() === '.pdf';
}

/**
 * Verify magic bytes. A `%PDF-` header is the strongest cheap signal; the
 * MIME type and extension are untrusted anyway. Content-Disposition / sniffing
 * would be more elaborate than this phase needs.
 *
 * Some PDF producers (especially compressed/linearized manuals) may prepend a
 * BOM or whitespace before the header.  We scan the first 1 KiB for the
 * signature rather than requiring it at byte 0, so such files are not
 * rejected before the pipeline can even attempt extraction.
 */
export function hasPdfMagicBytes(buffer: Buffer): boolean {
  // Fast path – most PDFs start with %PDF- at offset 0.
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head.startsWith('%PDF-')) return true;
  // Slow path – scan the first 1 KiB for the signature (handles BOM,
  // leading whitespace, or a UTF-8 BOM from some Windows tools).
  const scanLen = Math.min(buffer.length, 1024);
  const snippet = buffer.subarray(0, scanLen).toString('latin1');
  // Strip leading BOM / whitespace and look for %PDF-
  const trimmed = snippet.replace(/^\uFEFF/, '').trimStart();
  return trimmed.startsWith('%PDF-') || snippet.includes('%PDF-');
}

/**
 * Validate an uploaded PDF against every rule we can enforce without reading
 * the whole document. Returns the cleaned metadata and the SHA-256 digest used
 * for deduplication, or throws an ApiError.
 */
export function validatePdfUpload(
  file: UploadedFileInfo,
  maxSizeBytes: number,
): ValidatedPdf {
  // 1. Filename extension.
  if (!isPdfExtension(file.originalFilename)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Only PDF files are accepted.', {
      details: [{ field: 'file', issue: 'The file extension must be .pdf.' }],
    });
  }

  // 2. Declared MIME type (best-effort; magic bytes remain authoritative).
  const declared = file.mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (declared && !PDF_MIME_TYPES.includes(declared) && declared !== 'application/octet-stream') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Only PDF files are accepted.', {
      details: [{ field: 'file', issue: `Unexpected content type: ${declared}.` }],
    });
  }

  // 3. Empty file.
  if (file.size === 0 || file.buffer.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'The uploaded file is empty.', {
      details: [{ field: 'file', issue: 'An empty file cannot be processed.' }],
    });
  }

  // 4. Size limit.
  if (file.size > maxSizeBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'The uploaded file exceeds the size limit.', {
      details: [
        {
          field: 'file',
          issue: `Max size is ${Math.round(maxSizeBytes / (1024 * 1024))} MB.`,
        },
      ],
    });
  }

  // 5. Magic bytes - the only signal we trust for the actual content.
  if (!hasPdfMagicBytes(file.buffer)) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'The file is not a valid PDF.', {
      details: [{ field: 'file', issue: 'The file does not begin with a PDF signature.' }],
    });
  }

  return {
    buffer: file.buffer,
    originalFilename: sanitizeFilename(file.originalFilename),
    mimeType: 'application/pdf',
    size: file.size,
    sha256: sha256Hex(file.buffer),
  };
}

/** SHA-256 hex digest; the deduplication key. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Build the relative storage path for a manual's original PDF. */
export function manualStoragePath(manualStoragePath: string, manualId: string): string {
  return path.posix.join(manualStoragePath, manualId, 'original', 'source.pdf');
}

/** Absolute path for a manual's original PDF on disk. */
export function manualStorageAbsPath(storageRoot: string, relative: string): string {
  return path.join(storageRoot, ...relative.split('/'));
}

/** Ensure the directory for a file exists and return it. */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Persist an uploaded PDF to the local manual store. Returns the server-relative
 * storage path. On error the partially-written file is removed so no orphan
 * bytes are left behind.
 */
export async function storeManualPdf(
  storageRoot: string,
  manualStorageRelPath: string,
  manualId: string,
  buffer: Buffer,
): Promise<{ relativePath: string; absolutePath: string }> {
  const relativePath = manualStoragePath(manualStorageRelPath, manualId);
  const absolutePath = path.join(storageRoot, ...relativePath.split('/'));

  await ensureDir(path.dirname(absolutePath));
  try {
    await writeFile(absolutePath, buffer, { flag: 'wx' });
  } catch (error) {
    // `wx` fails on an existing path, which is our duplicate-file safety net
    // at the filesystem level. Clean up any partial file on write error.
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }

  return { relativePath, absolutePath };
}

/** Delete a manual's storage directory tree (best-effort). */
export async function removeManualStorageDir(
  storageRoot: string,
  manualId: string,
): Promise<void> {
  const dir = path.join(storageRoot, 'manuals', manualId);
  // rm is used rather than unlink so the whole tree (original/, extracted/, ...)
  // is removed. `force: true` makes it a no-op when already gone.
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** Generate a random local name suffix (used for temp staging if needed). */
export function randomLocalName(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Human-safe normalisation of a filename for diagnostics (not paths). */
export function displayFilename(filename: string): string {
  return sanitizeFilename(filename);
}
