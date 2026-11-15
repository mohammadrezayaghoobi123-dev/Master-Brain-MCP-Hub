// Operator resolution of quarantined (UNKNOWN) writes: store semantics, audit trail, CLI, and the
// quarantine log line. Every store behavior runs against BOTH the in-memory and SQLite backends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { createDedupStore, createMemoryDedupStore, sanitizeForDisplay, type DedupStore } from '../src/lib/dedup-store.js';
import { runCli, isEntrypoint, minResolveAgeMs, EXIT_CONFIRM, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from '../src/cli/dedup-admin.js';
import { AutoMemoryMiddleware } from '../src/middleware/auto-memory.js';
import { _resetBrainClientForTests } from '../src/brain/client.js';

const hex = (n: number, lead = 'ab12cd34'): string => lead + n.toString(16).padStart(64 - lead.length, '0');
const MIN = 60_000;

/** Quarantine `hash` exactly as the middleware does: claim, then markUnknown. Returns the owner token. */
function quarantine(store: DedupStore, hash: string): string {
  const token = store.claim(hash, 5);
  if (token === null) throw new Error('claim unexpectedly blocked');
  if (!store.markUnknown(hash, token)) throw new Error('markUnknown unexpectedly failed');
  return token;
}

const backends: Array<{ name: string; open: (dir: string) => DedupStore }> = [
  { name: 'memory', open: () => createMemoryDedupStore() },
  { name: 'sqlite', open: (dir) => createDedupStore(join(dir, 'dedup.sqlite'), { requireSqlite: true }) },
];

for (const backend of backends) {
  describe(`operator resolution — ${backend.name} store`, () => {
    let dir: string;
    let store: DedupStore;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dedup-op-'));
      store = backend.open(dir);
    });

    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('lists only UNKNOWN rows as 12-character prefixes', () => {
      quarantine(store, hex(1));
      quarantine(store, hex(2));
      store.claim(hex(3), 5); // pending: must not be listed
      const committedToken = store.claim(hex(4), 5) as string;
      store.markUnknown(hex(4), committedToken);
      store.commit(hex(4), committedToken, 30); // committed: must not be listed

      const listed = store.listUnknown();
      expect(listed).toHaveLength(2);
      for (const row of listed) expect(row.hashPrefix).toHaveLength(12);
      expect(listed.map((row) => row.hashPrefix).sort()).toEqual([hex(1).slice(0, 12), hex(2).slice(0, 12)]);
    });

    it('not_stored removes the quarantine, makes the content claimable again and writes an audit record', () => {
      const token = quarantine(store, hex(10));
      const result = store.resolveUnknown(hex(10).slice(0, 16), {
        outcome: 'not_stored',
        operator: 'alice',
        minAgeMs: 0,
        note: 'checked backend: absent',
      });
      expect(result).toEqual({ ok: true, hashPrefix: hex(10).slice(0, 12), outcome: 'not_stored' });
      expect(store.status(hex(10))).toBeNull();
      expect(store.unknownStats().count).toBe(0);
      expect(store.listResolutions()).toMatchObject([
        { hashPrefix: hex(10).slice(0, 12), outcome: 'not_stored', operator: 'alice', note: 'checked backend: absent' },
      ]);

      // The previous owner is stale now: it can neither commit nor overwrite a new claimant.
      expect(store.commit(hex(10), token, 30)).toBe(false);
      const fresh = store.claim(hex(10), 5);
      expect(fresh).not.toBeNull();
      expect(store.commit(hex(10), token, 30)).toBe(false);
      expect(store.status(hex(10))).toBe('pending');
    });

    it('stored commits the entry: it stays blocked and is no longer quarantined', () => {
      quarantine(store, hex(11));
      const result = store.resolveUnknown(hex(11).slice(0, 10), {
        outcome: 'stored',
        operator: 'bob',
        minAgeMs: 0,
        ttlMinutes: 30,
      });
      expect(result).toMatchObject({ ok: true, outcome: 'stored' });
      expect(store.status(hex(11))).toBe('committed');
      expect(store.unknownStats().count).toBe(0);
      expect(store.claim(hex(11), 5)).toBeNull();
    });

    it('never touches pending or committed rows', () => {
      const pendingToken = store.claim(hex(20), 5) as string;
      const committedToken = quarantine(store, hex(21));
      store.commit(hex(21), committedToken, 30);

      for (const hash of [hex(20), hex(21)]) {
        for (const outcome of ['not_stored', 'stored'] as const) {
          expect(store.resolveUnknown(hash.slice(0, 12), { outcome, operator: 'x', minAgeMs: 0 })).toEqual({
            ok: false,
            reason: 'not_found',
          });
        }
      }
      expect(store.status(hex(20))).toBe('pending');
      expect(store.status(hex(21))).toBe('committed');
      expect(store.markUnknown(hex(20), pendingToken)).toBe(true); // the owner is unaffected
      expect(store.listResolutions()).toHaveLength(0);
    });

    it.each([[''], ['abc'], ['zzzzzzzz'], ['ab12cd3%'], ['ab12cd3_'], ["'; DROP TABLE content_hashes;--"], ['a'.repeat(65)]])(
      'rejects the invalid prefix %s without changing anything',
      (prefix) => {
        quarantine(store, hex(30));
        expect(store.resolveUnknown(prefix, { outcome: 'not_stored', operator: 'x', minAgeMs: 0 })).toEqual({
          ok: false,
          reason: 'invalid_prefix',
        });
        expect(store.status(hex(30))).toBe('unknown');
        expect(store.listResolutions()).toHaveLength(0);
      }
    );

    it('refuses an ambiguous prefix and resolves nothing', () => {
      quarantine(store, hex(40));
      quarantine(store, hex(41));
      expect(store.resolveUnknown('ab12cd34', { outcome: 'not_stored', operator: 'x', minAgeMs: 0 })).toEqual({
        ok: false,
        reason: 'ambiguous',
      });
      expect(store.unknownStats().count).toBe(2);
      expect(store.listResolutions()).toHaveLength(0);
    });

    it('refuses a recently quarantined entry until the configured minimum age has elapsed', () => {
      quarantine(store, hex(50));
      const since = store.listUnknown()[0].unknownSince as number;
      const tooSoon = store.resolveUnknown(hex(50), {
        outcome: 'not_stored',
        operator: 'x',
        minAgeMs: 10 * MIN,
        now: since + 9 * MIN,
      });
      expect(tooSoon).toEqual({ ok: false, reason: 'too_recent' });
      expect(store.status(hex(50))).toBe('unknown');

      const old = store.resolveUnknown(hex(50), {
        outcome: 'not_stored',
        operator: 'x',
        minAgeMs: 10 * MIN,
        now: since + 10 * MIN,
      });
      expect(old).toMatchObject({ ok: true });
      expect(store.status(hex(50))).toBeNull();
    });

    it('a second resolution of the same entry is refused and leaves exactly one audit record', () => {
      quarantine(store, hex(60));
      const first = store.resolveUnknown(hex(60), { outcome: 'not_stored', operator: 'x', minAgeMs: 0 });
      const second = store.resolveUnknown(hex(60), { outcome: 'stored', operator: 'y', minAgeMs: 0 });
      expect(first).toMatchObject({ ok: true });
      expect(second).toEqual({ ok: false, reason: 'not_found' });
      expect(store.listResolutions()).toHaveLength(1);
    });

    it('bounds and sanitises audit fields (no control characters, length limits)', () => {
      quarantine(store, hex(70));
      store.resolveUnknown(hex(70), {
        outcome: 'not_stored',
        operator: `ev\nil\u0007${'o'.repeat(100)}`,
        minAgeMs: 0,
        note: `line1\nline2\r\n\u001b[31m${'n'.repeat(500)}`,
      });
      const [record] = store.listResolutions();
      expect(record.operator).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(record.operator.length).toBeLessThanOrEqual(64);
      expect(record.note).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect((record.note as string).length).toBeLessThanOrEqual(200);
    });

    it('never exposes a full hash or an owner token through the operator surface', () => {
      const token = quarantine(store, hex(80));
      store.resolveUnknown(hex(80), { outcome: 'stored', operator: 'x', minAgeMs: 0 });
      const dump = JSON.stringify([store.listUnknown(), store.listResolutions()]);
      expect(dump).not.toContain(hex(80));
      expect(dump).not.toContain(token);
    });
  });
}

describe('operator resolution — SQLite durability', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dedup-op-dur-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('survives a restart: unresolved UNKNOWN stays quarantined, resolutions and audit persist', () => {
    const path = join(dir, 'dedup.sqlite');
    let store = createDedupStore(path, { requireSqlite: true });
    quarantine(store, hex(90));
    quarantine(store, hex(91));
    store.resolveUnknown(hex(90), { outcome: 'stored', operator: 'carol', minAgeMs: 0, note: 'verified' });
    store.close();

    store = createDedupStore(path, { requireSqlite: true });
    try {
      expect(store.status(hex(90))).toBe('committed');
      expect(store.status(hex(91))).toBe('unknown');
      expect(store.claim(hex(91), 5)).toBeNull();
      expect(store.listResolutions()).toMatchObject([{ operator: 'carol', outcome: 'stored', note: 'verified' }]);
    } finally {
      store.close();
    }
  });

  it('opens a database created before the audit table existed (additive migration)', () => {
    const path = join(dir, 'dedup.sqlite');
    const first = createDedupStore(path, { requireSqlite: true });
    quarantine(first, hex(92));
    first.close();
    const again = createDedupStore(path, { requireSqlite: true });
    try {
      expect(again.listResolutions()).toEqual([]);
      expect(again.unknownStats().count).toBe(1);
    } finally {
      again.close();
    }
  });

  it('fails closed when a SQLite UNKNOWN row has no quarantine timestamp', () => {
    const path = join(dir, 'dedup.sqlite');
    const first = createDedupStore(path, { requireSqlite: true });
    quarantine(first, hex(93));
    first.close();

    // Simulate a damaged/legacy row. The production schema intentionally allows NULL here.
    const Database = require('better-sqlite3') as new (filename: string) => {
      prepare(sql: string): { run(...params: unknown[]): unknown };
      close(): void;
    };
    const raw = new Database(path);
    try {
      raw.prepare('UPDATE content_hashes SET unknown_since = NULL WHERE hash = ?').run(hex(93));
    } finally {
      raw.close();
    }

    const reopened = createDedupStore(path, { requireSqlite: true });
    try {
      expect(reopened.resolveUnknown(hex(93), {
        outcome: 'not_stored',
        operator: 'ops',
        minAgeMs: 0,
      })).toEqual({ ok: false, reason: 'missing_timestamp' });
      expect(reopened.status(hex(93))).toBe('unknown');
      expect(reopened.listResolutions()).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

describe('dedup-admin CLI', () => {
  let store: DedupStore;
  let out: string[];
  let err: string[];
  const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };

  beforeEach(() => {
    store = createMemoryDedupStore();
    out = [];
    err = [];
  });
  afterEach(() => store.close());

  it('list shows prefixes only and handles the empty case', () => {
    expect(runCli(['list'], { store, io })).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('No quarantined');
    out.length = 0;
    quarantine(store, hex(100));
    expect(runCli(['list'], { store, io })).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(hex(100).slice(0, 12));
    expect(out.join('\n')).not.toContain(hex(100));
  });

  it('resolve dry run does not report a truncated-prefix candidate count and changes nothing', () => {
    quarantine(store, hex(101));
    const code = runCli(['resolve', hex(101).slice(0, 12), '--outcome', 'not_stored'], { store, io, now: Date.now() + 60 * MIN });
    expect(code).toBe(EXIT_CONFIRM);
    expect(store.status(hex(101))).toBe('unknown');
    expect(out.join('\n')).toContain('eligible for resolution');
    expect(out.join('\n')).toContain(hex(101).slice(0, 12));
    expect(out.join('\n')).toContain('--yes');
  });

  it('resolve --yes applies, records the operator and the note, and audit prints it', () => {
    quarantine(store, hex(102));
    const code = runCli(
      ['resolve', hex(102).slice(0, 12), '--outcome', 'not_stored', '--yes', '--acknowledge-legacy-budget', '--note', 'absent in backend'],
      { store, io, operator: 'dana', now: Date.now() + 60 * MIN }
    );
    expect(code).toBe(EXIT_OK);
    expect(store.status(hex(102))).toBeNull();
    out.length = 0;
    expect(runCli(['audit'], { store, io })).toBe(EXIT_OK);
    expect(out.join('\n')).toMatch(/not_stored\s+by dana/);
    expect(out.join('\n')).toContain('absent in backend');
  });

  it('refuses attempts to lower the operator age guard', () => {
    quarantine(store, hex(103));
    const args = ['resolve', hex(103).slice(0, 12), '--outcome', 'not_stored', '--yes', '--acknowledge-legacy-budget'];
    expect(runCli(args, { store, io })).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain('too recently');
    expect(store.status(hex(103))).toBe('unknown');
    expect(runCli([...args, '--min-age-minutes', '0.0001'], { store, io, now: Date.now() + MIN })).toBe(EXIT_USAGE);
    expect(err.join('\n')).toContain('cannot be lowered');
    expect(store.status(hex(103))).toBe('unknown');
  });

  it.each([
    [[]],
    [['bogus']],
    [['resolve']],
    [['resolve', 'ab12cd34']],
    [['resolve', 'ab12cd34', '--outcome', 'maybe']],
    [['audit', '--limit', '-5']],
  ])('usage errors exit %s with code 1 and change nothing', (argv) => {
    quarantine(store, hex(104));
    expect(runCli(argv as string[], { store, io })).toBe(EXIT_USAGE);
    expect(store.status(hex(104))).toBe('unknown');
  });
});

describe('quarantine log line', () => {
  let server: Server;
  let received = 0;
  let status = 500;
  const savedUrl = process.env.BRAIN_API_URL;

  beforeEach(async () => {
    received = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        received += 1;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.BRAIN_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    _resetBrainClientForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedUrl === undefined) delete process.env.BRAIN_API_URL;
    else process.env.BRAIN_API_URL = savedUrl;
    _resetBrainClientForTests();
  });

  it('logs only a 12-character hash prefix when a write stays UNKNOWN, and the operator can then resolve it', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const dedup = createMemoryDedupStore();
    const middleware = new AutoMemoryMiddleware({ enabled: true }, dedup);
    (middleware as unknown as { analyzeImportance: () => Promise<unknown> }).analyzeImportance = async () => ({
      isImportant: true,
      type: 'decision',
      summary: 's',
      tags: [],
      confidence: 0.95,
    });
    try {
      await expect(middleware.processInteraction('log-req', 'log-res', { tool: 'api' })).rejects.toMatchObject({
        code: 'BRAIN_HTTP_ERROR',
      });
      const quarantineLines = lines.filter((line) => line.includes('UNKNOWN quarantine'));
      expect(quarantineLines).toHaveLength(1);
      expect(quarantineLines[0]).not.toMatch(/[0-9a-f]{13,}/);
      const [entry] = dedup.listUnknown();
      expect(quarantineLines[0]).toContain(entry.hashPrefix);

      // Blocked while quarantined; claimable again only after the operator resolves it.
      expect(await middleware.processInteraction('log-req', 'log-res', { tool: 'api' })).toMatchObject({
        reason: 'outcome_unknown',
      });
      expect(received).toBe(1);
      expect(
        dedup.resolveUnknown(entry.hashPrefix, { outcome: 'not_stored', operator: 'ops', minAgeMs: 0, now: Date.now() + 5 * MIN })
      ).toMatchObject({ ok: true });
      status = 201;
      await expect(middleware.processInteraction('log-req', 'log-res', { tool: 'api' })).rejects.toBeDefined();
      expect(received).toBe(2); // the retry was dispatched again only after explicit resolution
    } finally {
      middleware.close();
      status = 500;
    }
  });
});

describe('P11 review findings', () => {
  const dirs: string[] = [];
  const saved = { db: process.env.DEDUP_DB_PATH, data: process.env.DATA_DIR, timeout: process.env.BRAIN_TIMEOUT_MS };
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'dedup-p11-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of [['DEDUP_DB_PATH', saved.db], ['DATA_DIR', saved.data], ['BRAIN_TIMEOUT_MS', saved.timeout]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const backend of backends) {
    it(`[${backend.name}] P11-1: an entry cannot be resolved before its request's own timeout budget elapsed`, () => {
      const dir = tmp();
      const store = backend.open(dir);
      try {
        const token = store.claim(hex(200), 5) as string;
        store.markUnknown(hex(200), token, 2 * 60 * MIN + 1000); // 2h budget
        const t0 = Date.now();
        // minAgeMs satisfied (0), but the in-flight budget is not.
        expect(store.resolveUnknown(hex(200), { outcome: 'not_stored', operator: 'ops', minAgeMs: 0, now: t0 + 60 * MIN })).toEqual({
          ok: false,
          reason: 'in_flight',
        });
        expect(store.status(hex(200))).toBe('unknown');
        expect(store.resolveUnknown(hex(200), { outcome: 'not_stored', operator: 'ops', minAgeMs: 0, now: t0 + 3 * 60 * MIN })).toMatchObject({ ok: true });
      } finally {
        store.close();
      }
    });

    it(`[${backend.name}] P11-5: inspectUnknown previews eligibility without changing state`, () => {
      const dir = tmp();
      const store = backend.open(dir);
      try {
        quarantine(store, hex(201, 'cd34ab12'));
        quarantine(store, hex(202, 'cd34ab12'));
        const t0 = Date.now();
        expect(store.inspectUnknown('zz', { minAgeMs: 0 })).toEqual({ ok: false, reason: 'invalid_prefix' });
        expect(store.inspectUnknown('ffffffffff', { minAgeMs: 0 })).toEqual({ ok: false, reason: 'not_found' });
        expect(store.inspectUnknown('cd34ab12', { minAgeMs: 0 })).toEqual({ ok: false, reason: 'ambiguous' });
        expect(store.inspectUnknown(hex(201, 'cd34ab12'), { minAgeMs: 10 * MIN, now: t0 })).toEqual({ ok: false, reason: 'too_recent' });
        expect(store.inspectUnknown(hex(201, 'cd34ab12'), { minAgeMs: 10 * MIN, now: t0 + 20 * MIN })).toMatchObject({ ok: true });
        expect(store.status(hex(201, 'cd34ab12'))).toBe('unknown');
        expect(store.listResolutions()).toHaveLength(0);
      } finally {
        store.close();
      }
    });

    it(`[${backend.name}] P11-6: operator and note drop bidi/format/C1 control characters`, () => {
      const dir = tmp();
      const store = backend.open(dir);
      try {
        quarantine(store, hex(203));
        store.resolveUnknown(hex(203), {
          outcome: 'not_stored',
          operator: 'ev\u202eil\u0085ops\u2028x\u061c\ufeff\u200cz',
          minAgeMs: 0,
          note: 'a\u2066b\u200ec\u009fd',
        });
        const [record] = store.listResolutions();
        for (const field of [record.operator, record.note ?? '']) {
          expect(/[\u0085\u009f\u2028\u200e\u202e\u2066]/.test(field)).toBe(false);
        }
        expect(/[\u061c\ufeff]/.test(record.operator)).toBe(false);
        expect(record.operator).toContain('\u200cz'); // ZWNJ is legitimate Persian text
        expect(record.operator).toContain('ops');
        expect(record.note).toContain('d');
      } finally {
        store.close();
      }
    });
  }

  it('P11-1: the age floor follows BRAIN_TIMEOUT_MS (2x + 1s), never below 10 minutes', () => {
    delete process.env.BRAIN_TIMEOUT_MS;
    expect(minResolveAgeMs()).toBe(10 * MIN);
    process.env.BRAIN_TIMEOUT_MS = String(30 * MIN);
    expect(minResolveAgeMs()).toBe(60 * MIN + 1000);
  });

  it('P11-1: the middleware persists exactly 2 x BRAIN_TIMEOUT_MS + 1s when it quarantines', async () => {
    process.env.BRAIN_TIMEOUT_MS = '5000';
    const dedup = createMemoryDedupStore();
    const spy = vi.spyOn(dedup, 'markUnknown');
    const middleware = new AutoMemoryMiddleware({ enabled: true }, dedup);
    (middleware as unknown as { analyzeImportance: () => Promise<unknown> }).analyzeImportance = async () => ({
      isImportant: true, type: 'decision', summary: 's', tags: [], confidence: 0.95,
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    try {
      await middleware.processInteraction('budget-req', 'budget-res', { tool: 'api' }).catch(() => undefined);
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][2]).toBe(2 * 5000 + 1000);
    } finally {
      middleware.close();
      vi.restoreAllMocks();
    }
  });

  it('P11-2: --outcome stored requires an explicit --ttl-minutes', () => {
    const store = createMemoryDedupStore();
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    try {
      quarantine(store, hex(204));
      const base = ['resolve', hex(204).slice(0, 12), '--outcome', 'stored', '--yes', '--acknowledge-legacy-budget'];
      expect(runCli(base, { store, io, now: Date.now() + 60 * MIN })).toBe(EXIT_USAGE);
      expect(err.join('\n')).toContain('--ttl-minutes is required');
      expect(store.status(hex(204))).toBe('unknown');
      expect(runCli([...base, '--ttl-minutes', '30'], { store, io, now: Date.now() + 60 * MIN })).toBe(EXIT_OK);
      expect(store.status(hex(204))).toBe('committed');
    } finally {
      store.close();
    }
  });

  it('P11-3: the CLI refuses to create a missing database and names the path it looked at', () => {
    const dir = tmp();
    const missing = join(dir, 'nope', 'dedup.sqlite');
    process.env.DEDUP_DB_PATH = missing;
    const err: string[] = [];
    const code = runCli(['list'], { io: { out: () => undefined, err: (l) => err.push(l) } });
    expect(code).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain(missing);
    expect(err.join('\n')).toContain('DEDUP_DB_PATH');
  });

  it('P11-7: the CLI works end to end against a real SQLite database, and prints which one', () => {
    const dir = tmp();
    const path = join(dir, 'dedup.sqlite');
    const seed = createDedupStore(path, { requireSqlite: true });
    quarantine(seed, hex(205));
    seed.close();
    process.env.DEDUP_DB_PATH = path;
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    const later = Date.now() + 60 * MIN;
    expect(runCli(['list'], { io, now: later })).toBe(EXIT_OK);
    expect(out.join('\n')).toContain(path);
    expect(out.join('\n')).toContain(hex(205).slice(0, 12));
    expect(runCli(['resolve', hex(205).slice(0, 12), '--outcome', 'not_stored', '--yes', '--acknowledge-legacy-budget', '--note', 'checked'], { io, now: later, operator: 'dana' })).toBe(EXIT_OK);
    const check = createDedupStore(path, { requireSqlite: true });
    try {
      expect(check.status(hex(205))).toBeNull();
      expect(check.listResolutions()[0]).toMatchObject({ operator: 'dana', outcome: 'not_stored' });
    } finally {
      check.close();
    }
  });

  it('P11-7: an ambiguous prefix is refused with the right message and changes nothing', () => {
    const store = createMemoryDedupStore();
    const err: string[] = [];
    try {
      quarantine(store, hex(206, 'ee00ee00'));
      quarantine(store, hex(207, 'ee00ee00'));
      const code = runCli(['resolve', 'ee00ee00', '--outcome', 'not_stored', '--yes'], { store, io: { out: () => undefined, err: (l) => err.push(l) }, now: Date.now() + 60 * MIN });
      expect(code).toBe(EXIT_REFUSED);
      expect(err.join('\n')).toContain('longer prefix');
      expect(store.listUnknown()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('P11-7: if the audit insert fails the resolution is rolled back atomically (SQLite)', () => {
    const dir = tmp();
    const path = join(dir, 'dedup.sqlite');
    const store = createDedupStore(path, { requireSqlite: true });
    try {
      quarantine(store, hex(208));
      const Database = require('better-sqlite3');
      const second = new Database(path);
      second.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON unknown_resolutions BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
      second.close();
      expect(() => store.resolveUnknown(hex(208), { outcome: 'not_stored', operator: 'ops', minAgeMs: 0 })).toThrow();
      expect(store.status(hex(208))).toBe('unknown'); // the DELETE was rolled back with the failed audit
      expect(store.listResolutions()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('P11-4: entrypoint detection works through a symlink (npm .bin) and rejects other files', () => {
    const dir = tmp();
    const real = join(dir, 'real.js');
    writeFileSync(real, '');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const link = join(bin, 'dedup-admin');
    symlinkSync(real, link);
    const metaUrl = new URL(`file://${real}`).href;
    expect(isEntrypoint(metaUrl, real)).toBe(true);
    expect(isEntrypoint(metaUrl, link)).toBe(true);
    expect(isEntrypoint(metaUrl, join(dir, 'other.js'))).toBe(false);
    expect(isEntrypoint(metaUrl, undefined)).toBe(false);
  });

  for (const backend of backends) {
    it(`[${backend.name}] R20: an invalid in-flight budget is rejected instead of silently looking like a legacy row`, () => {
      const dir = tmp();
      const store = backend.open(dir);
      try {
        const token = store.claim(hex(210), 5) as string;
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
          expect(() => store.markUnknown(hex(210), token, bad)).toThrow();
        }
        expect(store.status(hex(210))).toBe('pending');
      } finally {
        store.close();
      }
    });
  }

  it('R20-4: the CLI resolve floor follows BRAIN_TIMEOUT_MS (a mutation to the fixed 10 minutes would fail this)', () => {
    process.env.BRAIN_TIMEOUT_MS = String(30 * MIN);
    const store = createMemoryDedupStore();
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l) };
    try {
      quarantine(store, hex(211));
      const t0 = Date.now();
      const args = ['resolve', hex(211).slice(0, 12), '--outcome', 'not_stored', '--yes', '--acknowledge-legacy-budget'];
      expect(runCli(args, { store, io, now: t0 + 20 * MIN })).toBe(EXIT_REFUSED); // > 10 min, < 2 x 30 min + 1s
      expect(store.status(hex(211))).toBe('unknown');
      expect(runCli(args, { store, io, now: t0 + 62 * MIN })).toBe(EXIT_OK);
    } finally {
      store.close();
    }
  });

  it('R20-2/R20-4: a legacy SQLite row (3-column schema, no budget) is migrated, flagged, and needs explicit acknowledgement', () => {
    const dir = tmp();
    const path = join(dir, 'dedup.sqlite');
    const Database = require('better-sqlite3');
    const old = new Database(path);
    old.exec(
      "CREATE TABLE content_hashes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'committed', owner TEXT, unknown_since INTEGER)"
    );
    old.prepare("INSERT INTO content_hashes(hash, expires_at, state, owner, unknown_since) VALUES(?, ?, 'unknown', 'o', ?)").run(
      hex(212),
      Number.MAX_SAFE_INTEGER,
      Date.now() - 2 * 60 * MIN
    );
    old.close();
    process.env.DEDUP_DB_PATH = path;
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    const prefix = hex(212).slice(0, 12);
    expect(runCli(['resolve', prefix, '--outcome', 'not_stored'], { io })).toBe(EXIT_CONFIRM);
    expect(out.join('\n')).toContain('WARNING');
    expect(runCli(['resolve', prefix, '--outcome', 'not_stored', '--yes'], { io })).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain('older Hub');
    const check = new Database(path);
    try {
      expect(check.prepare('PRAGMA table_info(content_hashes)').all().map((c: { name: string }) => c.name)).toContain('resolve_not_before');
      expect(check.prepare('SELECT state FROM content_hashes WHERE hash = ?').get(hex(212))).toMatchObject({ state: 'unknown' });
    } finally {
      check.close();
    }
    expect(runCli(['resolve', prefix, '--outcome', 'not_stored', '--yes', '--acknowledge-legacy-budget'], { io, operator: 'dana' })).toBe(EXIT_OK);
  });

  it('R20-5: committing an UNKNOWN entry clears its stored in-flight budget (SQLite)', () => {
    const dir = tmp();
    const path = join(dir, 'dedup.sqlite');
    const store = createDedupStore(path, { requireSqlite: true });
    const Database = require('better-sqlite3');
    try {
      const token = store.claim(hex(213), 5) as string;
      store.markUnknown(hex(213), token, 60_000);
      const peek = new Database(path);
      expect(peek.prepare('SELECT resolve_not_before AS r FROM content_hashes WHERE hash = ?').get(hex(213)).r).not.toBeNull();
      expect(store.commit(hex(213), token, 30)).toBe(true);
      expect(peek.prepare('SELECT resolve_not_before AS r FROM content_hashes WHERE hash = ?').get(hex(213)).r).toBeNull();
      peek.close();
    } finally {
      store.close();
    }
  });

  it('R20-3: the CLI refuses a zero-byte or directory database path and does not write into it', () => {
    const dir = tmp();
    const empty = join(dir, 'empty.sqlite');
    writeFileSync(empty, '');
    const err: string[] = [];
    for (const target of [empty, dir]) {
      process.env.DEDUP_DB_PATH = target;
      expect(runCli(['list'], { io: { out: () => undefined, err: (l) => err.push(l) } })).toBe(EXIT_REFUSED);
    }
    expect(err.length).toBe(2);
    expect(statSync(empty).size).toBe(0);
  });
});


describe('R20 review nits (print-time sanitiser, age message)', () => {
  it('sanitizeForDisplay strips invisible/format characters but keeps ZWNJ', () => {
    const dirty = 'a\u200bb\u00adc\u202ed\u{e0041}e\u001b[31mf\ufffag\u200ch';
    const out = sanitizeForDisplay(dirty);
    expect(/[\u200b\u00ad\u202e\u001b\ufffa]/u.test(out)).toBe(false);
    expect(/\u{e0041}/u.test(out)).toBe(false);
    expect(out.includes('\u200c')).toBe(true);
    expect(sanitizeForDisplay(undefined)).toBe('');
  });

  it('--min-age-minutes refusal names the real floor, not a fixed 10 minutes', () => {
    const store = createMemoryDedupStore();
    const err: string[] = [];
    const io = { out: () => {}, err: (m: string) => { err.push(m); } };
    const code = runCli(['resolve', hex(1), '--outcome', 'not_stored', '--min-age-minutes', '1', '--yes'], { store, io });
    expect(code).toBe(EXIT_USAGE);
    expect(err.join(' ').includes('2x BRAIN_TIMEOUT_MS')).toBe(true);
  });
});
