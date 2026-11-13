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

  it('a pending claim expires with its lease (crash recovery) and can be re-claimed', () => {
    store.claim('h', 1);
    advance(MIN + 1);
    expect(store.status('h')).toBeNull();
    expect(store.claim('h', 1)).toEqual(expect.any(String));
  });

  it('commit promotes pending to committed with the long TTL', () => {
    const token = store.claim('h', 1)!;
    expect(store.commit('h', token, 30)).toBe(true);
    expect(store.status('h')).toBe('committed');
    advance(10 * MIN); // far beyond the original lease
    expect(store.status('h')).toBe('committed');
    advance(21 * MIN);
    expect(store.status('h')).toBeNull();
  });

  it('a confirmed stale save supersedes a successor lease and remains committed if that successor releases', () => {
    const stale = store.claim('h', 1)!;
    advance(MIN + 1);
    const successor = store.claim('h', 5)!;
    expect(store.commit('h', stale, 30)).toBe(false); // caller lost lease ownership
    expect(store.status('h')).toBe('committed'); // but the backend save was confirmed
    store.release('h', successor); // successor failed before saving
    expect(store.status('h')).toBe('committed');
    expect(store.claim('h', 1)).toBeNull();
  });

  it('records a stale durable save after lease expiry when no successor owns the key', () => {
    const stale = store.claim('expired-h', 1)!;
    advance(MIN + 1);
    store.purgeExpired();
    expect(store.commit('expired-h', stale, 30)).toBe(false);
    expect(store.status('expired-h')).toBe('committed');
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
    store.commit('h', token, 30);
    store.release('h', token);
    expect(store.status('h')).toBe('committed');
  });

  it('add records a committed entry when the key is free', () => {
    store.add('h', 30);
    expect(store.status('h')).toBe('committed');
    expect(store.claim('h', 1)).toBeNull();
  });

  it('add can promote only the matching pending owner during recovery', () => {
    const owner = store.claim('h', 5)!;
    store.add('h', 30, owner);
    expect(store.status('h')).toBe('committed');
  });

  it('owner-aware post-save recovery records committed even after a successor lease starts', () => {
    const stale = store.claim('h', 1)!;
    advance(MIN + 1);
    const successor = store.claim('h', 5)!;
    store.add('h', 30, stale);
    expect(store.status('h')).toBe('committed');
    store.release('h', successor);
    expect(store.status('h')).toBe('committed');
  });

  it('add cannot overwrite a live pending reservation', () => {
    const owner = store.claim('h', 5)!;
    store.add('h', 30);
    expect(store.status('h')).toBe('pending');
    expect(store.commit('h', owner, 30)).toBe(true);
    expect(store.status('h')).toBe('committed');
  });
});

describe('SQLite two-phase persistence', () => {
  it('pending and committed entries survive a restart (reopen)', () => {
    const a = createDedupStore(dbPath);
    a.claim('pending-hash', 5);
    a.commit('committed-hash', a.claim('committed-hash', 5)!, 30);
    a.close();

    const b = createDedupStore(dbPath);
    expect(b.status('pending-hash')).toBe('pending');
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
  it('keeps the claim after a timeout and retries only after the lease', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      .mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toMatchObject({ code: 'TIMEOUT' });

    // the brain may already have stored it: an immediate retry must not create a second entry
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'duplicate_in_flight',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(3 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    mw.close();
  });

  it('documents the unresolved duplicate-write risk after a save commits but its response is lost', async () => {
    // Simulate a backend that commits the first POST, then the network drops
    // the response. The Hub cannot distinguish this from a request that never
    // reached the backend. After the pending lease expires it retries; without
    // a server-side idempotency key, the backend can persist the same entry twice.
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
    global.fetch = fetchMock as unknown as typeof fetch;
    const mw = makeMw(createMemoryDedupStore());

    await expect(mw.processInteraction('req', 'res', SRC)).rejects.toBeDefined();
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({
      saved: false,
      reason: 'duplicate_in_flight',
      retryable: true,
    });
    expect(backendWrites).toHaveLength(1);

    advance(3 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({ saved: true });
    expect(backendWrites).toHaveLength(2);
    expect(backendWrites[0]).toBe(backendWrites[1]);

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
      reason: 'duplicate_in_flight',
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
      reason: 'duplicate_in_flight',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });

  // The backend contract has no no-side-effects guarantee for HTTP errors.
  // All HTTP failures remain ambiguous until the claim lease expires.
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
      reason: 'duplicate_in_flight',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    mw.close();
  });
});

describe('concurrent identical interactions where the first save response is an HTTP error', () => {
  it('tells the loser it may retry; this client-side test does not prove backend exactly-once', async () => {
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
      reason: 'duplicate_in_flight',
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(3 * MIN);
    await expect(mw.processInteraction('req', 'res', SRC)).resolves.toMatchObject({ saved: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe('SQLite multi-process atomicity', () => {
  it('allows exactly one independent Node process to claim the same hash', async () => {
    // Initialize schema before racing so this test isolates claim atomicity, not DDL startup.
    const initialized = createDedupStore(dbPath);
    initialized.close();

    const childScript = `
      import { createDedupStore } from './src/lib/dedup-store.ts';
      const store = createDedupStore(process.argv[1]);
      const token = store.claim('cross-process-hash', 5);
      process.stdout.write(token === null ? 'null' : token);
      store.close();
    `;

    const claimInChild = () =>
      new Promise<string | null>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', childScript, dbPath],
          { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.once('error', reject);
        child.once('close', (code) => {
          if (code !== 0) return reject(new Error(`child claim failed (${code}): ${stderr}`));
          resolve(stdout === 'null' ? null : stdout);
        });
      });

    const results = await Promise.all([claimInChild(), claimInChild()]);
    expect(results.filter((token) => token !== null)).toHaveLength(1);
    expect(results.filter((token) => token === null)).toHaveLength(1);
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
describe('lease validation at the store boundary', () => {
  it.each([
    ['memory', () => createMemoryDedupStore()],
    ['sqlite', () => createDedupStore(dbPath)],
  ])('rejects a non-finite or non-positive lease instead of silently no-oping (%s)', (_name, make) => {
    const store = make();
    for (const bad of [Number.NaN, Infinity, 0, -1]) {
      expect(() => store.claim('bad-lease', bad)).toThrow('lease must be');
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
