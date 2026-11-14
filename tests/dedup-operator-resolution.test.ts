// Operator resolution of quarantined (UNKNOWN) writes: store semantics, audit trail, CLI, and the
// quarantine log line. Every store behavior runs against BOTH the in-memory and SQLite backends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import { createDedupStore, createMemoryDedupStore, type DedupStore } from '../src/lib/dedup-store.js';
import { runCli, EXIT_CONFIRM, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from '../src/cli/dedup-admin.js';
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
    expect(out.join('\n')).toContain('exactly one UNKNOWN entry');
    expect(out.join('\n')).toContain('--yes');
  });

  it('resolve --yes applies, records the operator and the note, and audit prints it', () => {
    quarantine(store, hex(102));
    const code = runCli(
      ['resolve', hex(102).slice(0, 12), '--outcome', 'not_stored', '--yes', '--note', 'absent in backend'],
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
    const args = ['resolve', hex(103).slice(0, 12), '--outcome', 'not_stored', '--yes'];
    expect(runCli(args, { store, io })).toBe(EXIT_REFUSED);
    expect(err.join('\n')).toContain('less than 10 minutes');
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
        dedup.resolveUnknown(entry.hashPrefix, { outcome: 'not_stored', operator: 'ops', minAgeMs: 0 })
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
