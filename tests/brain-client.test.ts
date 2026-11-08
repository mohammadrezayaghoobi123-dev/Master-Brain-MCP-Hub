import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrainClient } from '../src/brain/client.js';
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
