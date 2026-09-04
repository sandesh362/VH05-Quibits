/**
 * Unit tests for manual file validation, hash generation, filename
 * sanitisation, and duplicate detection helpers (no Mongo, no network).
 */
import { describe, expect, it } from 'vitest';
import {
  hasPdfMagicBytes,
  isPdfExtension,
  manualStoragePath,
  sanitizeFilename,
  sha256Hex,
  validatePdfUpload,
} from '../src/modules/manuals/manual-files.service.js';

const VALID_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');

describe('sha256Hex', () => {
  it('computes a 64-char hex digest deterministically', () => {
    const a = sha256Hex(Buffer.from('hello'));
    const b = sha256Hex(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs for different content', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')));
  });
});

describe('sanitizeFilename', () => {
  it('strips path separators and traversal sequences', () => {
    // The sanitised result is a single, safe file component.
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\etc\\passwd')).toBe('passwd');
  });

  it('keeps a normal filename', () => {
    expect(sanitizeFilename('EC180SX Service Manual.pdf')).toBe('EC180SX Service Manual.pdf');
  });

  it('replaces unsafe characters', () => {
    expect(sanitizeFilename('a<b>c.pdf')).toBe('a_b_c.pdf');
  });

  it('does not include path components', () => {
    expect(sanitizeFilename('C:\\temp\\manual.pdf')).toBe('manual.pdf');
  });
});

describe('isPdfExtension', () => {
  it('accepts .pdf case-insensitively', () => {
    expect(isPdfExtension('m.pdf')).toBe(true);
    expect(isPdfExtension('M.PDF')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isPdfExtension('m.txt')).toBe(false);
    expect(isPdfExtension('m')).toBe(false);
  });
});

describe('hasPdfMagicBytes', () => {
  it('recognises a PDF signature', () => {
    expect(hasPdfMagicBytes(VALID_PDF)).toBe(true);
  });

  it('rejects non-PDF bytes', () => {
    expect(hasPdfMagicBytes(Buffer.from('hello world'))).toBe(false);
  });
});

describe('validatePdfUpload', () => {
  const base = {
    buffer: VALID_PDF,
    originalFilename: 'manual.pdf',
    mimeType: 'application/pdf',
    size: VALID_PDF.length,
  };

  it('validates a good upload', () => {
    const result = validatePdfUpload(base, 100 * 1024 * 1024);
    expect(result.sha256).toHaveLength(64);
    expect(result.mimeType).toBe('application/pdf');
  });

  it('rejects an empty file', () => {
    expect(() =>
      validatePdfUpload({ ...base, buffer: Buffer.alloc(0), size: 0 }, 100),
    ).toThrow();
  });

  it('rejects an oversized file', () => {
    const big = Buffer.concat([VALID_PDF, Buffer.alloc(200)]);
    expect(() => validatePdfUpload({ ...base, buffer: big, size: big.length }, 10)).toThrowError(
      /exceeds the size limit/i,
    );
  });

  it('rejects a non-PDF extension', () => {
    expect(() => validatePdfUpload({ ...base, originalFilename: 'manual.txt' }, 100)).toThrowError(
      /Only PDF/i,
    );
  });

  it('rejects bytes without a PDF signature even with a .pdf name', () => {
    expect(() =>
      validatePdfUpload({ ...base, buffer: Buffer.from('not a pdf') }, 100),
    ).toThrowError(/not a valid PDF/i);
  });
});

describe('manualStoragePath', () => {
  it('builds a safe, server-generated path', () => {
    expect(manualStoragePath('manuals', 'abc123')).toBe(
      'manuals/abc123/original/source.pdf',
    );
  });
});
