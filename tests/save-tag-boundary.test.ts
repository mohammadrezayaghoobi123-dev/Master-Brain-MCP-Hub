import { describe, it, expect } from 'vitest';
import { saveSchema } from '../src/tools/save.js';

describe('brain_save tag input boundary', () => {
  const validBase = {
    content: 'A durable memory',
    type: 'decision' as const,
    tags: ['Decision', 'follow-up'],
  };

  it.each([
    [],
    [''],
    ['   '],
    ['\\t\\n'],
  ])('rejects tag arrays containing only blank values: %j', (tags) => {
    expect(saveSchema.safeParse({ ...validBase, tags }).success).toBe(false);
  });

  it('trims valid tags but preserves case for downstream normalization', () => {
    const result = saveSchema.safeParse({
      ...validBase,
      tags: ['  Decision ', ' FOLLOW-UP  '],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual(['Decision', 'FOLLOW-UP']);
  });

  it('rejects a tag that becomes empty after trimming among otherwise valid tags', () => {
    expect(saveSchema.safeParse({
      ...validBase,
      tags: ['valid', '   '],
    }).success).toBe(false);
  });
});
