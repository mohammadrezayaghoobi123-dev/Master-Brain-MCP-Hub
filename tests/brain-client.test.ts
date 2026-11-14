import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrainClient, _resetBrainClientForTests, getBrainClient } from '../src/brain/client.js';
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
        id: '123e4567-e89b-42d3-a456-426614174000',
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

  it.each([
    { ok: true },
    { id: 'missing-required-fields' },
    {
      id: '123',
      type: 'not-a-memory-type',
      content: 'Test content',
      tags: [],
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
    {
      id: '123',
      type: 'decision',
      content: 'Test content',
      tags: [],
      timestamp: 'not-a-date',
      source: { tool: 'claude-code' },
    },
    {
      id: 'not-a-uuid',
      type: 'decision',
      content: 'Test content',
      tags: ['test'],
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174000',
      type: 'decision',
      content: 'x'.repeat(10_001),
      tags: ['test'],
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174000',
      type: 'decision',
      content: 'Test content',
      tags: [],
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174000',
      type: 'decision',
      content: 'Test content',
      tags: Array.from({ length: 11 }, (_, i) => `tag-${i}`),
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
    {
      id: '123e4567-e89b-42d3-a456-426614174000',
      type: 'decision',
      content: 'Test content',
      summary: 's'.repeat(201),
      tags: ['test'],
      timestamp: new Date().toISOString(),
      source: { tool: 'claude-code' },
    },
  ])('rejects malformed 2xx BrainEntry response %#', async (body) => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => body });
    await expect(client.save({
      type: 'decision',
      content: 'Test content',
      tags: ['test'],
      source: { tool: 'claude-code' },
    })).rejects.toMatchObject({ code: 'BRAIN_HTTP_ERROR' });
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
  it('uses the documented 30-second default only when timeout is omitted', async () => {
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
      const client = new BrainClient({ baseUrl: 'http://localhost:3001' });
      await client.stats();
      expect(scheduledDelay).toBe(30_000);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid supplied timeout %s instead of silently normalizing it',
    (timeoutMs) => {
      expect(() => new BrainClient({ baseUrl: 'http://localhost:3001', timeoutMs })).toThrow(RangeError);
    }
  );
});

describe('BRAIN_TIMEOUT_MS environment validation', () => {
  it.each(['', 'abc', '0', '-1', '1.5', '2147483648', '9007199254740992'])(
    'fails closed for supplied invalid BRAIN_TIMEOUT_MS=%j',
    (raw) => {
      const previous = process.env.BRAIN_TIMEOUT_MS;
      try {
        process.env.BRAIN_TIMEOUT_MS = raw;
        _resetBrainClientForTests();
        expect(() => getBrainClient()).toThrow(RangeError);
      } finally {
        _resetBrainClientForTests();
        if (previous === undefined) delete process.env.BRAIN_TIMEOUT_MS;
        else process.env.BRAIN_TIMEOUT_MS = previous;
      }
    }
  );
});
