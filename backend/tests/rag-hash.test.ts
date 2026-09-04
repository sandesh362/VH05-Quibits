import { describe, it, expect } from 'vitest';
import { hashQuery } from '../src/modules/rag/rag.service.js';

describe('query hashing', () => {
  it('is stable and does not equal the raw query', () => {
    const query = 'Why is error E-104 appearing during hydraulic startup?';
    const hash = hashQuery(query);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hashQuery(query));
    expect(hash).not.toContain('E-104');
  });
});
