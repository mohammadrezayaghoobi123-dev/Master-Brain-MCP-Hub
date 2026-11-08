import { describe, it, expect } from 'vitest';
import { contentHash } from '../src/lib/hash.js';

describe('contentHash', () => {
  it('returns 64-char hex SHA-256', () => {
    const h = contentHash('hello');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable for identical input', () => {
    expect(contentHash('decision: use postgres')).toBe(
      contentHash('decision: use postgres')
    );
  });

  it('normalizes whitespace so trivial formatting does not evade dedup', () => {
    const a = contentHash('foo   bar\n\nbaz');
    const b = contentHash('foo bar baz');
    expect(a).toBe(b);
  });

  it('differs for different semantic content', () => {
    expect(contentHash('alpha')).not.toBe(contentHash('beta'));
  });
});
