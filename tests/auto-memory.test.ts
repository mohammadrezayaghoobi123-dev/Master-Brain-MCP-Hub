import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import type { DedupStore } from '../src/lib/dedup-store.js';
import { _resetBrainClientForTests } from '../src/brain/client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDedupStore, createMemoryDedupStore } from '../src/lib/dedup-store.js';
import { contentHash } from '../src/lib/hash.js';

// Use the production in-memory implementation so these tests exercise the real two-phase semantics.
function memoryDedup(): DedupStore {
  return createMemoryDedupStore();
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
    // The loser raced an in-flight interaction: it is retryable, not a final duplicate.
    expect(results.filter((result) => result.reason === 'duplicate_in_flight')).toHaveLength(1);
    expect(results.find((result) => result.reason === 'duplicate_in_flight')?.retryable).toBe(true);

    mw.close();
    _resetBrainClientForTests();
  });
});



describe('AutoMemoryMiddleware concurrent session limits', () => {
  it('reserves per-session capacity before concurrent analysis starts', async () => {
    const mw = new AutoMemoryMiddleware({ enabled: true, minConfidence: 0.7, maxEntriesPerSession: 1 }, memoryDedup());

    let releaseAnalysis!: () => void;
    const analysisGate = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    const analyze = vi.spyOn(mw as any, 'analyzeImportance').mockImplementation(async () => {
      await analysisGate;
      return {
        isImportant: true,
        type: 'decision',
        summary: 'One allowed session entry',
        tags: ['test'],
        confidence: 1,
      };
    });

    _resetBrainClientForTests();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'entry-1',
        type: 'decision',
        content: 'One allowed session entry',
        tags: ['test'],
        timestamp: new Date().toISOString(),
        source: { tool: 'manual' },
      }),
    }) as unknown as typeof fetch;

    const first = mw.processInteraction('request one', 'response one', {
      tool: 'manual',
      session_id: 'limited-session',
    });
    const second = await mw.processInteraction('request two', 'response two', {
      tool: 'manual',
      session_id: 'limited-session',
    });

    expect(second.saved).toBe(false);
    expect(second.reason).toBe('session_rate_limit');
    expect(analyze).toHaveBeenCalledTimes(1);

    releaseAnalysis();
    const firstResult = await first;
    expect(firstResult.saved).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mw.getStatus().sessionCounts['limited-session']).toBe(1);

    _resetBrainClientForTests();
  });
});


describe('AutoMemoryMiddleware reservation recovery', () => {
  const analysis = {
    isImportant: true,
    type: 'decision' as const,
    summary: 'Retryable durable decision',
    tags: ['recovery'],
    confidence: 1,
  };

  it('releases dedup and session reservations after analysis failure', async () => {
    const dedup = memoryDedup();
    const mw = new AutoMemoryMiddleware(
      { enabled: true, minConfidence: 0.7, maxEntriesPerSession: 2 },
      dedup
    );
    const analyze = vi.spyOn(mw as any, 'analyzeImportance')
      .mockRejectedValueOnce(new Error('temporary analysis failure'))
      .mockResolvedValueOnce(analysis);
    _resetBrainClientForTests();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'entry-retry',
        type: 'decision',
        content: analysis.summary,
        tags: analysis.tags,
        timestamp: new Date().toISOString(),
        source: { tool: 'manual', session_id: 'recovery-session' },
      }),
    }) as unknown as typeof fetch;

    try {
      await expect(mw.processInteraction('retry request', 'retry response', {
        tool: 'manual',
        session_id: 'recovery-session',
      })).rejects.toThrow('temporary analysis failure');

      await expect(mw.processInteraction('retry request', 'retry response', {
        tool: 'manual',
        session_id: 'recovery-session',
      })).resolves.toMatchObject({ saved: true });

      expect(analyze).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mw.getStatus().sessionCounts['recovery-session']).toBe(1);
    } finally {
      mw.close();
      _resetBrainClientForTests();
    }
  });

  it('retains the dedup claim after an HTTP save failure without a backend non-persistence guarantee', async () => {
    const dedup = memoryDedup();
    const mw = new AutoMemoryMiddleware(
      { enabled: true, minConfidence: 0.7, maxEntriesPerSession: 1 },
      dedup
    );
    const analyze = vi.spyOn(mw as any, 'analyzeImportance').mockResolvedValue(analysis);
    _resetBrainClientForTests();
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ message: 'definitive backend rejection' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'entry-retry',
          type: 'decision',
          content: analysis.summary,
          tags: analysis.tags,
          timestamp: new Date().toISOString(),
          source: { tool: 'manual', session_id: 'save-recovery-session' },
        }),
      }) as unknown as typeof fetch;

    try {
      await expect(mw.processInteraction('save retry request', 'save retry response', {
        tool: 'manual',
        session_id: 'save-recovery-session',
      })).rejects.toThrow('definitive backend rejection');

      await expect(mw.processInteraction('save retry request', 'save retry response', {
        tool: 'manual',
        session_id: 'save-recovery-session',
      })).resolves.toMatchObject({
        saved: false,
        reason: 'duplicate_in_flight',
        retryable: true,
      });

      expect(analyze).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mw.getStatus().sessionCounts['save-recovery-session']).toBeUndefined();
    } finally {
      mw.close();
      _resetBrainClientForTests();
    }
  });
});

describe('SQLite dedup reservations', () => {
  it('allows only one reservation across store instances sharing the same database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'master-brain-dedup-'));
    const databasePath = join(directory, 'dedup.sqlite');
    const first = createDedupStore(databasePath);
    const second = createDedupStore(databasePath);
    const hash = 'a'.repeat(64);

    try {
      const firstToken = first.claim(hash, 1);
      expect(firstToken).toEqual(expect.any(String));
      expect(second.claim(hash, 1)).toBeNull();
      first.release(hash, firstToken!);
      const secondToken = second.claim(hash, 1);
      expect(secondToken).toEqual(expect.any(String));
      second.release(hash, secondToken!);
    } finally {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let an expired reservation release delete a newer claim', () => {
    const directory = mkdtempSync(join(tmpdir(), 'master-brain-dedup-lease-'));
    const databasePath = join(directory, 'dedup.sqlite');
    const first = createDedupStore(databasePath);
    const second = createDedupStore(databasePath);
    const hash = 'b'.repeat(64);
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_700_000_000_000);
      const oldToken = first.claim(hash, 1);
      expect(oldToken).toEqual(expect.any(String));

      now.mockReturnValue(1_700_000_060_001);
      const newToken = second.claim(hash, 1);
      expect(newToken).toEqual(expect.any(String));
      expect(newToken).not.toBe(oldToken);

      first.release(hash, oldToken!);
      expect(second.has(hash)).toBe(true);

      second.release(hash, newToken!);
      expect(second.has(hash)).toBe(false);
    } finally {
      now.mockRestore();
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe('AutoMemoryMiddleware concurrent session limits', () => {
  it('does not allow concurrent distinct interactions to exceed the per-session save limit', async () => {
    const mw = new AutoMemoryMiddleware({ enabled: true, minConfidence: 0.7, maxEntriesPerSession: 1 }, memoryDedup());

    let releaseAnalysis!: () => void;
    let signalFirstAnalysis!: () => void;
    let signalSecondAnalysis!: () => void;
    const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
    const firstStarted = new Promise<void>((resolve) => { signalFirstAnalysis = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecondAnalysis = resolve; });

    let analysisCalls = 0;
    vi.spyOn(mw as any, 'analyzeImportance').mockImplementation(async () => {
      analysisCalls += 1;
      if (analysisCalls === 1) signalFirstAnalysis();
      else signalSecondAnalysis();
      await analysisGate;
      return {
        isImportant: true,
        type: 'decision',
        summary: 'A durable decision',
        tags: ['test'],
        confidence: 1,
      };
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'entry-1',
        type: 'decision',
        content: 'A durable decision',
        tags: ['test'],
        source: { tool: 'manual', session_id: 'session-1' },
        timestamp: '2026-11-09T00:00:00.000Z',
      }),
    });
    global.fetch = fetchMock as any;

    const first = mw.processInteraction('request one', 'response one', {
      tool: 'manual',
      session_id: 'session-1',
    });
    await firstStarted;

    const secondPromise = mw.processInteraction('request two', 'response two', {
      tool: 'manual',
      session_id: 'session-1',
    });
    const secondOutcome = await Promise.race([
      secondPromise.then((result) => ({ kind: 'result' as const, result })),
      secondStarted.then(() => ({ kind: 'analysis' as const })),
    ]);

    expect(secondOutcome).toEqual({
      kind: 'result',
      result: { saved: false, reason: 'session_rate_limit' },
    });

    releaseAnalysis();
    expect(await first).toMatchObject({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('AutoMemoryMiddleware durable-save recovery', () => {
  it('preserves the pending lease when claim promotion fails after a durable save', async () => {
    const dedup = memoryDedup();
    const commit = vi.spyOn(dedup, 'commit').mockImplementation(() => {
      throw new Error('temporary dedup store failure');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mw = new AutoMemoryMiddleware(
      { enabled: true, minConfidence: 0.7, maxEntriesPerSession: 2 },
      dedup
    );
    const analysis = {
      isImportant: true,
      type: 'decision' as const,
      summary: 'Durably saved despite dedup refresh failure',
      tags: ['recovery'],
      confidence: 1,
    };
    vi.spyOn(mw as any, 'analyzeImportance').mockResolvedValue(analysis);
    _resetBrainClientForTests();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'entry-durable',
        type: 'decision',
        content: analysis.summary,
        tags: analysis.tags,
        timestamp: new Date().toISOString(),
        source: { tool: 'manual', session_id: 'durable-save-session' },
      }),
    }) as unknown as typeof fetch;

    try {
      await expect(mw.processInteraction('durable request', 'durable response', {
        tool: 'manual',
        session_id: 'durable-save-session',
      })).resolves.toMatchObject({ saved: true });

      expect(commit).toHaveBeenCalledTimes(1);
      expect(dedup.status(contentHash('durable request\n---\ndurable response'))).toBe('pending');
      expect(mw.getStatus().sessionCounts['durable-save-session']).toBe(1);
      await expect(mw.processInteraction('durable request', 'durable response', {
        tool: 'manual',
        session_id: 'durable-save-session',
      })).resolves.toMatchObject({ saved: false, reason: 'duplicate_in_flight', retryable: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      mw.close();
      _resetBrainClientForTests();
    }
  });
});
