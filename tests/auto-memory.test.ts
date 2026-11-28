import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AutoMemoryMiddleware, _internal } from '../src/middleware/auto-memory.js';
import type { DedupStore } from '../src/lib/dedup-store.js';

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
      { enabled: true, minConfidence: 0.75, maxEntriesPerSession: 2 },
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

  it('status exposes hard floor and effective minimum', () => {
    const s = mw.getStatus();
    expect(s.confidenceHardFloor).toBe(_internal.CONFIDENCE_HARD_FLOOR);
    expect(s.effectiveMinConfidence).toBe(
      Math.max(s.config.minConfidence, _internal.CONFIDENCE_HARD_FLOOR)
    );
  });

  it('effectiveMinConfidence never below hard floor', () => {
    mw.updateConfig({ minConfidence: 0.1 });
    expect(mw.effectiveMinConfidence()).toBe(_internal.CONFIDENCE_HARD_FLOOR);
    mw.updateConfig({ minConfidence: 0.95 });
    expect(mw.effectiveMinConfidence()).toBe(0.95);
  });
});

describe('normalizeTags', () => {
  it('lowercases, hyphenates, dedupes, strips junk', () => {
    expect(_internal.normalizeTags(['  Foo Bar ', 'foo-bar', 'OK!', '', 'x'.repeat(100)])).toEqual([
      'foo-bar',
      'ok',
      'x'.repeat(64),
    ]);
  });

  it('returns empty for unusable input', () => {
    expect(_internal.normalizeTags([])).toEqual([]);
    expect(_internal.normalizeTags(['???', '   '])).toEqual([]);
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
