import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrainClient, _resetBrainClientForTests } from '../src/brain/client.js';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import { createMemoryDedupStore } from '../src/lib/dedup-store.js';
import { AppError } from '../src/lib/errors.js';

describe('BrainClient', () => {
  it('strips trailing slash from baseUrl', () => {
    const c = new BrainClient({ baseUrl: 'http://localhost:3001/' });
    // @ts-expect-error private
    expect(c.baseUrl).toBe('http://localhost:3001');
  });

  it('returns ok:false when server unreachable', async () => {
    const client = new BrainClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 200,
    });
    const result = await client.health();
    expect(result.ok).toBe(false);
  });
});

describe('BrainClient — API calls', () => {
  let client: BrainClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    client = new BrainClient({
      baseUrl: 'http://localhost:3001',
      apiKey: 'test-key',
    });
  });

  it('calls search with auth header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ entries: [], total: 0, query: 'test', mode: 'hybrid' }),
    });

    const result = await client.search('test query');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/brain/search'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
        }),
      })
    );
    expect(result.query).toBe('test');
  });

  it('calls save endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: '123',
        type: 'decision',
        content: 'Test content',
        tags: ['test'],
        timestamp: new Date().toISOString(),
        source: { tool: 'claude-code' },
      }),
    });

    const result = await client.save({
      type: 'decision',
      content: 'Test content',
      tags: ['test'],
      source: { tool: 'claude-code' },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/brain/entries',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.id).toBe('123');
  });

  it('throws AppError BRAIN_HTTP_ERROR on 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });

    await expect(client.stats()).rejects.toMatchObject({ code: 'BRAIN_HTTP_ERROR' });
  });
});


describe('BrainClient timeout validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'uses the 30-second default for invalid timeout %s',
    async (timeoutMs) => {
      let scheduledDelay: number | undefined;
      const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        _handler: TimerHandler,
        timeout?: number
      ) => {
        scheduledDelay = Number(timeout);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ totalEntries: 0 }),
      }) as unknown as typeof fetch;

      try {
        const invalidClient = new BrainClient({ baseUrl: 'http://localhost:3001', timeoutMs });
        await invalidClient.stats();
        expect(scheduledDelay).toBe(30_000);
      } finally {
        timerSpy.mockRestore();
      }
    }
  );
});


describe('timeout upper-bound validation', () => {
  it.each([2_147_483_648, Number.MAX_VALUE])(
    'uses the 30-second default when BrainClient timeout exceeds Node timer maximum (%s)',
    async (timeoutMs) => {
      let scheduledDelay: number | undefined;
      const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        _handler: TimerHandler,
        timeout?: number
      ) => {
        scheduledDelay = Number(timeout);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ totalEntries: 0 }),
      }) as unknown as typeof fetch;

      try {
        const client = new BrainClient({ baseUrl: 'http://localhost:3001', timeoutMs });
        await client.stats();
        expect(scheduledDelay).toBe(30_000);
      } finally {
        global.fetch = originalFetch;
        timerSpy.mockRestore();
      }
    }
  );
});


describe('Auto-Memory timeout upper-bound validation', () => {
  it.each([2_147_483_648, Number.MAX_VALUE])(
    'uses the 60-second default when analysis timeout exceeds Node timer maximum (%s)',
    async (analysisTimeoutMs) => {
      const originalFetch = global.fetch;
      _resetBrainClientForTests();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'entry-1',
          type: 'decision',
          content: 'A durable decision',
          tags: ['timeout'],
          timestamp: new Date().toISOString(),
          source: { tool: 'manual' },
        }),
      }) as unknown as typeof fetch;

      const mw = new AutoMemoryMiddleware(
        { enabled: true, analysisTimeoutMs },
        createMemoryDedupStore()
      );
      const create = vi.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            isImportant: true,
            type: 'decision',
            summary: 'A durable decision',
            tags: ['timeout'],
            confidence: 1,
          }),
        }],
      });
      vi.spyOn(mw as any, 'getAnthropic').mockReturnValue({ messages: { create } } as any);

      try {
        await expect(
          mw.processInteraction('request', 'response', { tool: 'manual', session_id: 'timeout-boundary' })
        ).resolves.toMatchObject({ saved: true });
        expect(create).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ timeout: 60_000, maxRetries: 0 })
        );
      } finally {
        mw.close();
        global.fetch = originalFetch;
        _resetBrainClientForTests();
      }
    }
  );
});
