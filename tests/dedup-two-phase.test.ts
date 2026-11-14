import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import { createDedupStore, createMemoryDedupStore } from '../src/lib/dedup-store.js';
import type { DedupStore } from '../src/lib/dedup-store.js';
import { contentHash } from '../src/lib/hash.js';
import { _resetBrainClientForTests } from '../src/brain/client.js';

const require = createRequire(import.meta.url);
const originalFetch = global.fetch;
const T0 = 1_700_000_000_000;
const MIN = 60_000;

let dir: string;
let dbPath: string;
let nowSpy: ReturnType<typeof vi.spyOn>;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'master-brain-two-phase-'));
  dbPath = join(dir, 'dedup.sqlite');
  clock = T0;
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  _resetBrainClientForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  _resetBrainClientForTests();
  rmSync(dir, { recursive: true, force: true });
});

const advance = (ms: number) => {
  clock += ms;
};

const analysis = {
  isImportant: true,
  type: 'decision' as const,
  summary: 'A durable decision',
  tags: ['two-phase'],
  confidence: 1,
};
const savedEntry = {
  id: 'e1',
  type: 'decision',
  content: analysis.summary,
  tags: analysis.tags,
  timestamp: '2026-11-12T00:00:00.000Z',
  source: { tool: 'manual' },
};
const okResponse = () => ({ ok: true, status: 201, json: async () => savedEntry });

function makeMw(store: DedupStore, extra: Record<string, unknown> = {}) {
  const mw = new AutoMemoryMiddleware(
    { enabled: true, minConfidence: 0.7, maxEntriesPerSession: 100, ...extra },
    store
  );
  vi.spyOn(mw as any, 'analyzeImportance').mockResolvedValue(analysis);
  return mw;
}

const SRC = { tool: 'manual' as const, session_id: 'two-phase' };
const HASH = contentHash('req\n---\nres');

describe.each([
  ['memory', () => createMemoryDedupStore()],
  ['sqlite', () => createDedupStore(dbPath)],
])('two-phase DedupStore contract (%s)', (name, make) => {
  let store: DedupStore;
  beforeEach(() => {
    store = make();
  });
  afterEach(() => store.close());

  it('reports its backend', () => {
    expect(store.backend).toBe(name);
  });

  it('claim is exclusive while the pending lease is live, and visible as pending', () => {
    const token = store.claim('h', 1);
    expect(token).toEqual(expect.any(String));
    expect(store.claim('h', 1)).toBeNull();
    expect(store.status('h')).toBe('pending');
    expect(store.has('h')).toBe(true);
  });

  it('an unknown outcome never expires, is never purged, and blocks a new claim', () => {
    const owner = store.claim('h', 1)!;
    expect(store.markUnknown('h', owner)).toBe(true);
    advance(25 * 60 * MIN);
    expect(store.purgeExpired()).toBe(0);
    expect(store.status('h')).toBe('unknown');
    expect(store.claim('h', 1)).toBeNull();
    store.release('h', owner);
    expect(store.status('h')).toBe('unknown');
  });

  it('only the current owner can transition pending to unknown', () => {
    const owner = store.claim('h', 1)!;
    expect(store.markUnknown('h', 'not-the-owner')).toBe(false);
    expect(store.status('h')).toBe('pending');
    expect(store.markUnknown('h', owner)).toBe(true);
    expect(store.markUnknown('h', owner)).toBe(false);
    expect(store.status('h')).toBe('unknown');
  });

  it('the matching owner can commit an unknown outcome after confirmed persistence', () => {
    const owner = store.claim('h', 1)!;
    expect(store.markUnknown('h', owner)).toBe(true);
    expect(store.commit('h', owner, 30)).toBe(true);
    expect(store.status('h')).toBe('committed');
  });

  it('cannot skip the pending-to-unknown transition when committing', () => {
    const owner = store.claim('pending-commit', 5)!;
    expect(store.commit('pending-commit', owner, 30)).toBe(false);
    expect(store.status('pending-commit')).toBe('pending');
  });

  it('reports unknown quarantine count and oldest timestamp', () => {
    const first = store.claim('unknown-1', 5)!;
    expect(store.markUnknown('unknown-1', first)).toBe(true);
    advance(MIN);
    const second = store.claim('unknown-2', 5)!;
    expect(store.markUnknown('unknown-2', second)).toBe(true);
    expect(store.unknownStats()).toEqual({ count: 2, oldestAt: T0 });
    expect(store.commit('unknown-1', first, 30)).toBe(true);
    expect(store.unknownStats()).toEqual({ count: 1, oldestAt: T0 + MIN });
  });

  it('rejects invalid commit and add TTL values without changing current state', () => {
    const owner = store.claim('ttl', 5)!;
    expect(() => store.commit('ttl', owner, Number.NaN)).toThrow(RangeError);
    expect(() => store.commit('ttl', owner, 0.000001)).toThrow(RangeError);
    expect(() => store.add('other', 0)).toThrow(RangeError);
    expect(() => store.add('other', Number.MAX_VALUE)).toThrow(RangeError);
    expect(store.status('ttl')).toBe('pending');
  });

  it('cannot use add() to resolve an UNKNOWN quarantine', () => {
    const owner = store.claim('unknown-add', 5)!;
    expect(store.markUnknown('unknown-add', owner)).toBe(true);
    store.add('unknown-add', 30);
    expect(store.status('unknown-add')).toBe('unknown');
  });

  it('does not expose an owner-token overload that bypasses UNKNOWN transitions', () => {
    const owner = store.claim('no-add-owner', 5)!;
    // @ts-expect-error add() is intentionally ownerless; commit() is the only owner-bound finalizer.
    store.add('no-add-owner', 30, owner);
    expect(store.status('no-add-owner')).toBe('pending');
  });

  it('a pending claim expires with its lease (crash before dispatch) and can be re-claimed', () => {
    store.claim('h', 1);
    advance(MIN + 1);
    expect(store.status('h')).toBeNull();
    expect(store.claim('h', 1)).toEqual(expect.any(String));
  });

  it('commit promotes unknown to committed with the long TTL', () => {
    const token = store.claim('h', 1)!;
    expect(store.markUnknown('h', token)).toBe(true);
    expect(store.commit('h', token, 30)).toBe(true);
    expect(store.status('h')).toBe('committed');
    advance(10 * MIN); // far beyond the original lease
    expect(store.status('h')).toBe('committed');
    advance(21 * MIN);
    expect(store.status('h')).toBeNull();
  });

  it('a stale confirmed save cannot overwrite a successor claim', () => {
    const stale = store.claim('h', 1)!;
    advance(MIN + 1);
    const successor = store.claim('h', 5)!;
    expect(store.commit('h', stale, 30)).toBe(false);
    expect(store.status('h')).toBe('pending');
    store.release('h', successor);
    expect(store.status('h')).toBeNull();
  });

  it('does not resurrect an expired claim from a stale owner commit', () => {
    const stale = store.claim('expired-h', 1)!;
    advance(MIN + 1);
    store.purgeExpired();
    expect(store.commit('expired-h', stale, 30)).toBe(false);
    expect(store.status('expired-h')).toBeNull();
  });

  it('release only removes the caller\'s own pending claim', () => {
    const stale = store.claim('h', 1)!;
    advance(MIN + 1);
    const newer = store.claim('h', 1)!;
    store.release('h', stale);
    expect(store.status('h')).toBe('pending'); // newer claim survives a stale release
    store.release('h', newer);
    expect(store.status('h')).toBeNull();
  });

  it('a committed entry cannot be released', () => {
    const token = store.claim('h', 1)!;
    store.markUnknown('h', token);
    store.commit('h', token, 30);
    store.release('h', token);
    expect(store.status('h')).toBe('committed');
  });

  it('add records a committed entry when the key is free', () => {
    store.add('h', 30);
    expect(store.status('h')).toBe('committed');
    expect(store.claim('h', 1)).toBeNull();
  });

  it('add cannot overwrite a live pending or unknown reservation', () => {
    const owner = store.claim('h', 5)!;
    store.add('h', 30);
    expect(store.status('h')).toBe('pending');
    expect(store.markUnknown('h', owner)).toBe(true);
    store.add('h', 30);
    expect(store.status('h')).toBe('unknown');
  });

  it('ownerless add cannot overwrite a successor lease', () => {
    store.claim('h', 1);
    advance(MIN + 1);
    const successor = store.claim('h', 5)!;
    store.add('h', 30);
    expect(store.status('h')).toBe('pending');
    store.release('h', successor);
    expect(store.status('h')).toBeNull();
  });

  it('add cannot overwrite a live pending reservation', () => {
    const owner = store.claim('h', 5)!;
    store.add('h', 30);
    expect(store.status('h')).toBe('pending');
    expect(store.markUnknown('h', owner)).toBe(true);
    expect(store.commit('h', owner, 30)).toBe(true);
    expect(store.status('h')).toBe('committed');
  });
});

describe('SQLite two-phase persistence', () => {
  it('pending, unknown, and committed entries survive a restart (reopen)', () => {
    const a = createDedupStore(dbPath);
    a.claim('pending-hash', 5);
    const unknownOwner = a.claim('unknown-hash', 5)!;
    expect(a.markUnknown('unknown-hash', unknownOwner)).toBe(true);
    const committedOwner = a.claim('committed-hash', 5)!;
    a.markUnknown('committed-hash', committedOwner);
    a.commit('committed-hash', committedOwner, 30);
    a.close();

    const b = createDedupStore(dbPath);
    expect(b.status('pending-hash')).toBe('pending');
    expect(b.status('unknown-hash')).toBe('unknown');
    expect(b.unknownStats()).toEqual({ count: 1, oldestAt: T0 });
    expect(b.claim('unknown-hash', 5)).toBeNull();
    expect(b.status('committed-hash')).toBe('committed');
    b.close();
  });

  it('migrates a PR #2 schema in place (legacy rows become committed) and is idempotent', () => {
    const Database = require('better-sqlite3');
    const old = new Database(dbPath);
    old.exec('CREATE TABLE content_hashes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    old.prepare('INSERT INTO content_hashes(hash, expires_at) VALUES (?, ?)').run('legacy', T0 + 10 * MIN);
    old.close();

    const first = createDedupStore(dbPath);
    const second = createDedupStore(dbPath); // second open must not fail on ALTER TABLE
    expect(first.backend).toBe('sqlite');
    expect(second.backend).toBe('sqlite');
    expect(first.status('legacy')).toBe('committed');
    expect(first.claim('legacy', 1)).toBeNull();
    expect(first.claim('fresh', 1)).toEqual(expect.any(String));
    first.close();
    second.close();
  });

  it('only one of two handles on the same database wins a claim', () => {
    const a = createDedupStore(dbPath);
    const b = createDedupStore(dbPath);
    const winners = [a.claim('h', 1), b.claim('h', 1)].filter((t) => t !== null);
    expect(winners).toHaveLength(1);
    a.close();
    b.close();
  });
});

describe('crash between claim and save (shared SQLite file)', () => {
  it('does not lose the interaction: in-flight now, savable once the lease expires', async () => {
    const crashed = makeMw(createDedupStore(dbPath));
    vi.spyOn(crashed as any, 'analyzeImportance').mockImplementation(() => new Promise(() => {}));
    void crashed.processInteraction('req', 'res', SRC); // process "dies" here: no release, no save

    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const restarted = makeMw(createDedupStore(dbPath));
    const immediately = await restarted.processInteraction('req', 'res', SRC);
    expect(immediately).toMatchObject({ saved: false, reason: 'duplicate_in_flight', retryable: true });
    expect(fetchMock).not.toHaveBeenCalled();

    advance(3 * MIN); // beyond the effective lease
    await expect(restarted.processInteraction('req', 'res', SRC)).resolves.toMatchObject({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // and from now on it is a final duplicate
    await expect(restarted.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'duplicate',
    });
    restarted.close();
  });
});

describe('ambiguous save outcome (response loss)', () => {
  it('does not dispatch when the pending claim expires before UNKNOWN transition', async () => {
    const store = createMemoryDedupStore();
    const markUnknown = store.markUnknown.bind(store);
    vi.spyOn(store, 'markUnknown').mockImplementation((hash, token) => {
      advance(3 * MIN);
      return markUnknown(hash, token);
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(store);

    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'claim_lost',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.status(HASH)).toBeNull();
    mw.close();
  });

  it('does not dispatch when durable UNKNOWN transition throws', async () => {
    const store = createMemoryDedupStore();
    vi.spyOn(store, 'markUnknown').mockImplementation(() => {
      throw new Error('sqlite write failure');
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(store);

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toThrow('sqlite write failure');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.status(HASH)).toBeNull();
    mw.close();
  });
  it('keeps an ambiguous timeout quarantined beyond the original lease', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .mockResolvedValue(okResponse());
    const store = createMemoryDedupStore();
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(store);

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(store.status(HASH)).toBe('unknown');

    advance(25 * 60 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  it('does not retry a possibly committed write after its response is lost', async () => {
    const backendWrites: string[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        backendWrites.push(String(init.body));
        throw new Error('connection reset after backend commit');
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        backendWrites.push(String(init.body));
        return okResponse();
      });
    const store = createMemoryDedupStore();
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(store);

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toBeDefined();
    expect(store.status(HASH)).toBe('unknown');

    advance(25 * 60 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(backendWrites).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  it('keeps UNKNOWN when a 2xx response body violates the BrainEntry contract', async () => {
    const store = createMemoryDedupStore();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ ok: true }),
    }) as unknown as typeof fetch;
    const mw = makeMw(store);
    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toMatchObject({
      code: 'BRAIN_HTTP_ERROR',
    });
    expect(store.status(HASH)).toBe('unknown');
    expect(mw.getStatus().unknownClaims.count).toBe(1);
    mw.close();
  });

  it('treats a 2xx response with an unreadable body as ambiguous, not as a failed save', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toBeDefined();
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  // HTTP statuses after which the brain may or may not have stored the entry: the claim must be kept.
  it.each([408, 500, 502, 503, 504])('keeps the claim after HTTP %i (outcome unknown)', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status, json: async () => ({ message: 'upstream trouble' }) })
      .mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toBeDefined();
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  // The backend contract has no no-side-effects guarantee for HTTP errors.
  // Every dispatched failure remains quarantined until authoritative reconciliation.
  it.each([400, 401, 403, 404, 422, 429])('keeps the claim after HTTP %i (no non-persistence guarantee)', async (status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status, json: async () => ({ message: 'not stored' }) })
      .mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toBeDefined();
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });
});

describe('concurrent identical interactions where the first save response is an HTTP error', () => {
  it('keeps the first dispatched request quarantined after an ambiguous HTTP error', async () => {
    let releaseAnalysis!: () => void;
    const gate = new Promise<void>((r) => (releaseAnalysis = r));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ message: 'rejected' }) })
      .mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const mw = makeMw(createMemoryDedupStore());
    vi.spyOn(mw as any, 'analyzeImportance').mockImplementation(async () => {
      await gate;
      return analysis;
    });

    const first = mw.processInteraction('req', 'res', SRC).then(
      (r) => r,
      (e) => ({ thrown: e.code })
    );
    const second = await mw.processInteraction('req', 'res', SRC);
    expect(second).toMatchObject({ saved: false, reason: 'duplicate_in_flight', retryable: true });

    releaseAnalysis();
    expect(await first).toEqual({ thrown: 'BRAIN_HTTP_ERROR' });

    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(25 * 60 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'outcome_unknown',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });
});

describe('claim lease versus processing time', () => {
  it('holds the claim for at least analysis + brain timeout, whatever the configured lease', async () => {
    let releaseAnalysis!: () => void;
    const gate = new Promise<void>((r) => (releaseAnalysis = r));
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    const mw = makeMw(createMemoryDedupStore(), { claimLeaseMinutes: 0.0001, analysisTimeoutMs: 20_000 });
    vi.spyOn(mw as any, 'analyzeImportance').mockImplementation(async () => {
      await gate;
      return analysis;
    });

    const first = mw.processInteraction('req', 'res', SRC);
    advance(20_000); // slower than the configured lease, still within analysis + brain timeout
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      reason: 'duplicate_in_flight',
    });

    releaseAnalysis();
    await expect(first).resolves.toMatchObject({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  it('a committed entry outlives the pending lease and stays a final duplicate', async () => {
    global.fetch = vi.fn().mockResolvedValue(okResponse()) as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());
    await mw.processInteraction('req', 'res', SRC);
    advance(10 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'duplicate',
    });
    mw.close();
  });
});

describe('observability', () => {
  it('exposes the active dedup backend in getStatus()', () => {
    const memory = makeMw(createMemoryDedupStore());
    expect(memory.getStatus().dedupBackend).toBe('memory');
    memory.close();

    const sqlite = makeMw(createDedupStore(dbPath));
    expect(sqlite.getStatus().dedupBackend).toBe('sqlite');
    sqlite.close();
  });
});

describe('SQLite busy-lock behavior', () => {
  it('fails closed without blocking the event loop for the default five-second SQLite timeout', () => {
    const store = createDedupStore(dbPath, { requireSqlite: true });
    const Database = require('better-sqlite3') as new (path: string) => {
      exec(sql: string): void;
      close(): void;
    };
    const blocker = new Database(dbPath);
    blocker.exec('BEGIN EXCLUSIVE');
    const started = performance.now();

    try {
      expect(() => store.claim('busy-lock-hash', 1)).toThrow(/SQLITE_BUSY|database is locked/i);
      expect(performance.now() - started).toBeLessThan(250);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
      store.close();
    }

    const recovered = createDedupStore(dbPath, { requireSqlite: true });
    try {
      expect(recovered.claim('busy-lock-hash', 1)).toEqual(expect.any(String));
    } finally {
      recovered.close();
    }
  }, 10_000);
});

describe('SQLite multi-process atomicity', () => {
  it('allows exactly one independent Node process to claim the same hash', async () => {
    // Initialize schema before racing so this test isolates claim atomicity, not DDL startup.
    const initialized = createDedupStore(dbPath);
    initialized.close();

    const childScript = `
      import { createDedupStore } from './src/lib/dedup-store.ts';
      const store = createDedupStore(process.argv[1]);
      process.stdout.write('READY\\n');
      let input = '';
      for await (const chunk of process.stdin) {
        input += chunk.toString();
        if (input.includes('\\n')) break;
      }
      if (input.trim() !== 'GO') {
        store.close();
        process.exitCode = 2;
      } else {
        const token = store.claim('cross-process-hash', 5);
        process.stdout.write('RESULT:' + (token === null ? 'null' : token) + '\\n');
        store.close();
      }
    `;

    const startChild = () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript, dbPath],
        { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      let ready = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let resolveResult!: (value: string | null) => void;
      let rejectResult!: (error: Error) => void;
      const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const resultPromise = new Promise<string | null>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        const lines = stdout.split('\n');
        if (!ready && lines.includes('READY')) {
          ready = true;
          resolveReady();
        }
        const resultLine = lines.find((line) => line.startsWith('RESULT:'));
        if (resultLine) resolveResult(resultLine.slice('RESULT:'.length) === 'null' ? null : resultLine.slice('RESULT:'.length));
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.once('error', (error) => {
        rejectReady(error);
        rejectResult(error);
      });
      child.once('close', (code) => {
        if (code !== 0) {
          const error = new Error(`child claim failed (${code}): ${stderr}`);
          rejectReady(error);
          rejectResult(error);
        } else if (!stdout.split('\n').some((line) => line.startsWith('RESULT:'))) {
          rejectResult(new Error(`child exited without a claim result: ${stdout}`));
        }
      });
      return { child, readyPromise, resultPromise };
    };

    const workers = [startChild(), startChild()];
    const timeout = setTimeout(() => {
      for (const worker of workers) worker.child.kill('SIGKILL');
    }, 10_000);

    try {
      // Do not release either process until both independent SQLite clients are ready.
      await Promise.all(workers.map((worker) => worker.readyPromise));
      for (const worker of workers) worker.child.stdin.write('GO\n');

      const results = await Promise.all(workers.map((worker) => worker.resultPromise));
      expect(results.filter((token) => token !== null)).toHaveLength(1);
      expect(results.filter((token) => token === null)).toHaveLength(1);

      const verification = createDedupStore(dbPath);
      try {
        expect(verification.status('cross-process-hash')).toBe('pending');
      } finally {
        verification.close();
      }
    } finally {
      clearTimeout(timeout);
      for (const worker of workers) {
        if (worker.child.exitCode === null && !worker.child.killed) worker.child.kill('SIGTERM');
      }
    }
  });
});

describe('SQLite constructor cleanup', () => {
  it('rolls back and closes the native handle when schema migration fails after open', () => {
    const statements: string[] = [];
    let closed = false;
    class FakeDatabase {
      exec(sql: string) {
        statements.push(sql);
        if (statements.length === 2) throw new Error('synthetic migration failure');
      }
      close() {
        closed = true;
      }
    }
    expect(() =>
      createDedupStore(dbPath, {
        requireSqlite: true,
        loadDriver: () => FakeDatabase,
      })
    ).toThrow(/SQLite is required.*synthetic migration failure/);
    expect(statements[0]).toBe('BEGIN IMMEDIATE');
    expect(statements[2]).toBe('ROLLBACK');
    expect(closed).toBe(true);
  });
});

describe('lease configuration validation', () => {
  it.each([
    { claimLeaseMinutes: Number.NaN },
    { claimLeaseMinutes: Number.POSITIVE_INFINITY },
    { claimLeaseMinutes: 0 },
    { claimLeaseMinutes: -1 },
    { claimLeaseMinutes: 1440.001 },
    { deduplicationWindowMinutes: Number.NaN },
    { deduplicationWindowMinutes: Number.POSITIVE_INFINITY },
    { deduplicationWindowMinutes: 0 },
    { deduplicationWindowMinutes: -1 },
    { deduplicationWindowMinutes: 0.000001 },
    { analysisTimeoutMs: Number.NaN },
    { analysisTimeoutMs: Number.POSITIVE_INFINITY },
    { analysisTimeoutMs: 0 },
    { analysisTimeoutMs: -1 },
    { analysisTimeoutMs: 1.5 },
  ])('rejects invalid time configuration %#', (invalidConfig) => {
    expect(
      () => new AutoMemoryMiddleware({ enabled: true, ...invalidConfig } as any, createMemoryDedupStore())
    ).toThrow(RangeError);
  });

  it.each([
    { analysisTimeoutMs: Number.POSITIVE_INFINITY },
    { deduplicationWindowMinutes: Number.NaN },
    { claimLeaseMinutes: 1441 },
  ])('keeps the prior valid configuration when updateConfig rejects %#', (supplied) => {
    const mw = makeMw(createMemoryDedupStore());
    const before = mw.getStatus().config;
    const original = { ...supplied };
    try {
      expect(() => mw.updateConfig(supplied)).toThrow(RangeError);
      expect(mw.getStatus().config).toEqual(before);
      expect(supplied).toEqual(original);
    } finally {
      mw.close();
    }
  });
});

describe('SQLite unavailable (controlled)', () => {
  const failingLoader = () => {
    throw Object.assign(new Error("Cannot find module 'better-sqlite3'"), { code: 'MODULE_NOT_FOUND' });
  };

  it('falls back to memory outside production when explicitly allowed, and reports its backend', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRequireSqlite = process.env.DEDUP_REQUIRE_SQLITE;
    process.env.NODE_ENV = 'test';
    delete process.env.DEDUP_REQUIRE_SQLITE;
    try {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const store = createDedupStore(':memory:', { requireSqlite: false, loadDriver: failingLoader });
      expect(store.backend).toBe('memory');
      expect(spy).toHaveBeenCalled();
      store.close();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousRequireSqlite === undefined) delete process.env.DEDUP_REQUIRE_SQLITE;
      else process.env.DEDUP_REQUIRE_SQLITE = previousRequireSqlite;
    }
  });

  it('fails closed when SQLite is required', () => {
    expect(() => createDedupStore(':memory:', { requireSqlite: true, loadDriver: failingLoader })).toThrow(
      'SQLite is required'
    );
  });

  it('fails closed when DEDUP_REQUIRE_SQLITE=1 is set', () => {
    process.env.DEDUP_REQUIRE_SQLITE = '1';
    try {
      expect(() => createDedupStore(':memory:', { loadDriver: failingLoader })).toThrow('SQLite is required');
    } finally {
      delete process.env.DEDUP_REQUIRE_SQLITE;
    }
  });
});

describe('Auto-Memory analysis timeout validation', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648, Number.MAX_VALUE])(
    'rejects invalid analysis timeout %s',
    (analysisTimeoutMs) => {
      expect(() => new AutoMemoryMiddleware({ enabled: true, analysisTimeoutMs })).toThrow(RangeError);
    }
  );
});

describe('lease validation at the store boundary', () => {
  it.each([
    ['memory', () => createMemoryDedupStore()],
    ['sqlite', () => createDedupStore(dbPath)],
  ])('rejects a non-finite or non-positive lease instead of silently no-oping (%s)', (_name, make) => {
    const store = make();
    for (const bad of [Number.NaN, Infinity, 0, -1, 0.000001, 1440.001, Number.MAX_VALUE]) {
      expect(() => store.claim('bad-lease', bad)).toThrow(RangeError);
    }
    expect(store.status('bad-lease')).toBeNull();
    store.close();
  });

});

describe('Idempotency-Key header', () => {
  it('sends the content hash so an idempotency-aware backend can collapse retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());
    await mw.processInteraction('req', 'res', SRC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['Idempotency-Key']).toBe(HASH);
    mw.close();
  });
});

describe('UNKNOWN recovery ownership', () => {
  it.each([
    ['memory', () => createMemoryDedupStore()],
    ['sqlite', () => createDedupStore(dbPath)],
  ])('%s store only reverts UNKNOWN for its exact owner', (_name, make) => {
    const store = make();
    const owner = store.claim('revert-h', 5)!;
    expect(store.revertUnknown('revert-h', owner)).toBe(false);
    expect(store.markUnknown('revert-h', owner)).toBe(true);
    expect(store.revertUnknown('revert-h', 'stale-owner')).toBe(false);
    expect(store.status('revert-h')).toBe('unknown');
    expect(store.revertUnknown('revert-h', owner)).toBe(true);
    expect(store.status('revert-h')).toBeNull();
    store.close();
  });
});

describe('production SQLite path configuration', () => {
  it('fails closed without an explicit absolute DEDUP_DB_PATH or DATA_DIR', () => {
    const original = {
      NODE_ENV: process.env.NODE_ENV,
      DEDUP_DB_PATH: process.env.DEDUP_DB_PATH,
      DATA_DIR: process.env.DATA_DIR,
    };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DEDUP_DB_PATH;
      delete process.env.DATA_DIR;
      expect(() => createDedupStore()).toThrow(/production requires an absolute DEDUP_DB_PATH or DATA_DIR/);
      process.env.DATA_DIR = 'relative-data';
      expect(() => createDedupStore()).toThrow(/production requires an absolute DEDUP_DB_PATH or DATA_DIR/);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('accepts an absolute DATA_DIR in production', () => {
    const original = {
      NODE_ENV: process.env.NODE_ENV,
      DEDUP_DB_PATH: process.env.DEDUP_DB_PATH,
      DATA_DIR: process.env.DATA_DIR,
    };
    let store: DedupStore | undefined;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DEDUP_DB_PATH;
      process.env.DATA_DIR = dir;
      store = createDedupStore();
      expect(store.backend).toBe('sqlite');
    } finally {
      store?.close();
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
