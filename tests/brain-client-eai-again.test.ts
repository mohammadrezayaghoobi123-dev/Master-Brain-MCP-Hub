import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainClient } from '../src/brain/client.js';
import { AppError } from '../src/lib/errors.js';

describe('BrainClient — Fetch DNS error classification', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('classifies a Node Fetch EAI_AGAIN cause as definitely not dispatched', async () => {
    const cause = Object.assign(new Error('temporary name resolution failure'), { code: 'EAI_AGAIN' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause })));

    const client = new BrainClient({ baseUrl: 'http://brain.invalid', timeoutMs: 1000 });
    let caught: unknown;
    try {
      await client.save({ type: 'decision', content: 'test', tags: [], source: { tool: 'api' } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'BRAIN_UNREACHABLE',
      details: { networkCode: 'EAI_AGAIN', requestDisposition: 'not_dispatched' },
    });
  });
});