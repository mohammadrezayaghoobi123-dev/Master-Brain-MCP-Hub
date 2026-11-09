import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import type { DedupStore } from '../src/lib/dedup-store.js';
import { _resetBrainClientForTests } from '../src/brain/client.js';

function memoryDedup(): DedupStore {
  const map = new Map<string, number>();
  return {
    has: (h) => {
      const exp = map.get(h);
      if (exp === undefined) return false;
      if (Date.now() > exp) {
        map.delete(h);
        return false;
      }
      return true;
    },
    claim: (h, ttl) => {
      const exp = map.get(h);
      if (exp !== undefined && Date.now() <= exp) return false;
      map.set(h, Date.now() + ttl * 60_000);
      return true;
    },
    release: (h) => {
      map.delete(h);
    },
    add: (h, ttl) => {
      map.set(h, Date.now() + ttl * 60_000);
    },
    purgeExpired: () => 0,
    size: () => map.size,
    close: () => map.clear(),
  };
}

describe('AutoMemoryMiddleware', () => {
  let mw: AutoMemoryMiddleware;

  beforeEach(() => {
    mw = new AutoMemoryMiddleware(
      { enabled: true, minConfidence: 0.7, maxEntriesPerSession: 2 },
      memoryDedup()
    );
  });

  afterEach(() => {
    mw.close();
  });

  it('skips when disabled', async () => {
    mw.updateConfig({ enabled: false });
    const r = await mw.processInteraction('q', 'a', { tool: 'manual' });
    expect(r.saved).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  it('updateConfig clamps minConfidence into [0,1]', () => {
    mw.updateConfig({ minConfidence: 2 });
    expect(mw.getStatus().config.minConfidence).toBe(1);
    mw.updateConfig({ minConfidence: -1 });
    expect(mw.getStatus().config.minConfidence).toBe(0);
  });
});

describe('content hash integration (dedup)', () => {
  it('second identical interaction is rejected as duplicate after hash is recorded', async () => {
    const dedup = memoryDedup();
    const mw = new AutoMemoryMiddleware({ enabled: true, minConfidence: 0.99 }, dedup);

    const { contentHash } = await import('../src/lib/hash.js');
    const h = contentHash('same request\n---\nsame response');
    dedup.add(h, 30);

    const r = await mw.processInteraction('same request', 'same response', {
      tool: 'manual',
      session_id: 's1',
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toBe('duplicate');
    mw.close();
  });
});


describe('AutoMemoryMiddleware concurrent deduplication', () => {
  it('allows only one concurrent save for the same request/response pair', async () => {
    const dedup = memoryDedup();
    const mw = new AutoMemoryMiddleware({ enabled: true, minConfidence: 0.5 }, dedup);
    const analysis = {
      isImportant: true,
      type: 'decision' as const,
      summary: 'A durable decision',
      tags: ['decision'],
      confidence: 0.99,
    };

    let releaseAnalysis!: () => void;
    const analysisGate = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    const analyze = vi.spyOn(mw as any, 'analyzeImportance').mockImplementation(async () => {
      await analysisGate;
      return analysis;
    });

    _resetBrainClientForTests();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'entry-1',
        type: 'decision',
        content: 'A durable decision',
        tags: ['decision'],
        timestamp: new Date().toISOString(),
        source: { tool: 'manual' },
      }),
    }) as unknown as typeof fetch;

    const first = mw.processInteraction('same request', 'same response', {
      tool: 'manual',
      session_id: 'concurrent-session',
    });
    const second = mw.processInteraction('same request', 'same response', {
      tool: 'manual',
      session_id: 'concurrent-session',
    });

    await Promise.resolve();
    releaseAnalysis();
    const results = await Promise.all([first, second]);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.saved)).toHaveLength(1);
    expect(results.filter((result) => result.reason === 'duplicate')).toHaveLength(1);

    mw.close();
    _resetBrainClientForTests();
  });
});
