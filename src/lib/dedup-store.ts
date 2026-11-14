// Persistent content-hash store for auto-memory deduplication (two-phase).
//
//   pending   = pre-dispatch reservation; expires after its lease.
//   unknown   = a write may have been dispatched; durable quarantine, no expiry.
//   committed = the save is confirmed; retained for the dedup window.
//
// A possibly dispatched write must never become claimable merely because its
// lease elapsed. UNKNOWN is intentionally non-expiring until authoritative
// reconciliation is available. This favors duplicate-write safety over liveness.
//
// Uses better-sqlite3 when available; falls back to in-process Map.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { leaseMinutesToMs, MAX_EFFECTIVE_LEASE_MS } from './time-budget.js';

const require = createRequire(import.meta.url);

export type DedupState = 'pending' | 'unknown' | 'committed';

/** What an operator established, out of band, about a quarantined (UNKNOWN) write. */
export type UnknownOutcome = 'not_stored' | 'stored';

export interface UnknownEntrySummary {
  /** First 12 hex characters of the content hash; the full hash is never exposed. */
  hashPrefix: string;
  unknownSince: number | null;
}

export interface ResolveUnknownOptions {
  outcome: UnknownOutcome;
  /** Operator identity recorded in the audit trail. */
  operator: string;
  /** Refuse entries quarantined more recently than this, so an in-flight request is never resolved. */
  minAgeMs: number;
  /** Retention of a `stored` outcome as a committed entry (minutes). Defaults to 30. */
  ttlMinutes?: number;
  note?: string;
  now?: number;
}

export type ResolveUnknownResult =
  | { ok: true; hashPrefix: string; outcome: UnknownOutcome }
  | { ok: false; reason: 'invalid_prefix' | 'not_found' | 'ambiguous' | 'too_recent' };

export interface ResolutionRecord {
  at: number;
  hashPrefix: string;
  outcome: UnknownOutcome;
  operator: string;
  note: string | null;
}

const HASH_PREFIX_PATTERN = /^[0-9a-f]{8,64}$/;
export const DEFAULT_RESOLVE_TTL_MINUTES = 30;

export interface DedupStore {
  /** Which backend is actually in use (observability: memory means no cross-process dedup). */
  readonly backend: 'sqlite' | 'memory';
  /** True when a committed, pending, or quarantined unknown entry exists. */
  has(hash: string): boolean;
  /** State of the live entry for `hash`, or null. */
  status(hash: string): DedupState | null;
  /** Atomically reserve `hash` for `leaseMinutes`. Returns an owner token, or null when blocked. */
  claim(hash: string, leaseMinutes: number): string | null;
  /** Atomically quarantine the current owner's pending claim before external write dispatch. */
  markUnknown(hash: string, token: string): boolean;
  /** Remove UNKNOWN only when the same owner proves the request was never dispatched. */
  revertUnknown(hash: string, token: string): boolean;
  /** Commit only the matching current owner; stale owners must never overwrite another claim. */
  commit(hash: string, token: string, ttlMinutes: number): boolean;
  /** Deletes the entry only if it is still the caller's PENDING reservation. UNKNOWN is never released. */
  release(hash: string, token: string): void;
  /** Record a committed entry only when no reservation or quarantine currently exists. */
  add(hash: string, ttlMinutes: number): void;
  /** Safe operational summary of quarantined UNKNOWN rows; never exposes hashes or owner tokens. */
  unknownStats(): { count: number; oldestAt: number | null };
  /** Operator-only (CLI, never an MCP tool): quarantined rows, oldest first, hash prefixes only. */
  listUnknown(limit?: number): UnknownEntrySummary[];
  /**
   * Operator-only, atomic and audited resolution of exactly one UNKNOWN row identified by a unique
   * hash prefix. `not_stored` makes the content claimable again; `stored` commits it. Never touches
   * pending or committed rows.
   */
  resolveUnknown(hashPrefix: string, options: ResolveUnknownOptions): ResolveUnknownResult;
  /** Operator-only: most recent resolutions first. */
  listResolutions(limit?: number): ResolutionRecord[];
  purgeExpired(): number;
  size(): number;
  close(): void;
}

interface MemoryEntry {
  exp: number;
  state: DedupState;
  owner: string | null;
  unknownSince: number | null;
}

class MemoryDedupStore implements DedupStore {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly resolutions: ResolutionRecord[] = [];

  private live(hash: string): MemoryEntry | undefined {
    const e = this.entries.get(hash);
    if (!e) return undefined;
    if (e.state !== 'unknown' && Date.now() > e.exp) {
      this.entries.delete(hash);
      return undefined;
    }
    return e;
  }

  has(hash: string): boolean {
    return this.live(hash) !== undefined;
  }

  status(hash: string): DedupState | null {
    return this.live(hash)?.state ?? null;
  }

  claim(hash: string, leaseMinutes: number): string | null {
    assertValidLease(leaseMinutes);
    if (this.live(hash)) return null;
    const owner = randomUUID();
    this.entries.set(hash, { exp: Date.now() + leaseMinutes * 60_000, state: 'pending', owner, unknownSince: null });
    return owner;
  }

  markUnknown(hash: string, token: string): boolean {
    const e = this.live(hash);
    if (!e || e.state !== 'pending' || e.owner !== token) return false;
    e.state = 'unknown';
    e.exp = Number.POSITIVE_INFINITY;
    e.unknownSince = Date.now();
    return true;
  }

  revertUnknown(hash: string, token: string): boolean {
    const entry = this.entries.get(hash);
    if (!entry || entry.state !== 'unknown' || entry.owner !== token) return false;
    this.entries.delete(hash);
    return true;
  }

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const expiresAt = expiresAtForTtl(ttlMinutes);
    const e = this.live(hash);
    if (!e || e.state !== 'unknown' || e.owner !== token) {
      return false;
    }
    this.entries.set(hash, {
      exp: expiresAt,
      state: 'committed',
      owner: null,
      unknownSince: null,
    });
    return true;
  }

  release(hash: string, token: string): void {
    const e = this.entries.get(hash);
    if (e && e.state === 'pending' && e.owner === token) this.entries.delete(hash);
  }

  add(hash: string, ttlMinutes: number): void {
    const expiresAt = expiresAtForTtl(ttlMinutes);
    if (this.live(hash)) return;
    this.entries.set(hash, {
      exp: expiresAt,
      state: 'committed',
      owner: null,
      unknownSince: null,
    });
  }

  unknownStats(): { count: number; oldestAt: number | null } {
    let count = 0;
    let oldestAt: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'unknown') continue;
      count += 1;
      if (entry.unknownSince !== null && (oldestAt === null || entry.unknownSince < oldestAt)) {
        oldestAt = entry.unknownSince;
      }
    }
    return { count, oldestAt };
  }

  listUnknown(limit = 100): UnknownEntrySummary[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.state === 'unknown')
      .map(([hash, entry]) => ({ hashPrefix: hash.slice(0, 12), unknownSince: entry.unknownSince }))
      .sort((a, b) => (a.unknownSince ?? 0) - (b.unknownSince ?? 0))
      .slice(0, normalizeLimit(limit));
  }

  resolveUnknown(hashPrefix: string, options: ResolveUnknownOptions): ResolveUnknownResult {
    const prefix = normalizePrefix(hashPrefix);
    if (!prefix) return { ok: false, reason: 'invalid_prefix' };
    const matches = [...this.entries.entries()].filter(
      ([hash, entry]) => entry.state === 'unknown' && hash.startsWith(prefix)
    );
    if (matches.length === 0) return { ok: false, reason: 'not_found' };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
    const [hash, entry] = matches[0];
    const now = options.now ?? Date.now();
    if (entry.unknownSince !== null && now - entry.unknownSince < options.minAgeMs) {
      return { ok: false, reason: 'too_recent' };
    }
    const expiresAt =
      options.outcome === 'stored'
        ? expiresAtForTtl(options.ttlMinutes ?? DEFAULT_RESOLVE_TTL_MINUTES, now)
        : 0;
    if (options.outcome === 'stored') {
      this.entries.set(hash, { exp: expiresAt, state: 'committed', owner: null, unknownSince: null });
    } else {
      this.entries.delete(hash);
    }
    this.resolutions.unshift({
      at: now,
      hashPrefix: hash.slice(0, 12),
      outcome: options.outcome,
      operator: normalizeOperator(options.operator),
      note: normalizeNote(options.note),
    });
    return { ok: true, hashPrefix: hash.slice(0, 12), outcome: options.outcome };
  }

  listResolutions(limit = 100): ResolutionRecord[] {
    return this.resolutions.slice(0, normalizeLimit(limit));
  }

  purgeExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [h, e] of this.entries) {
      if (e.state !== 'unknown' && now > e.exp) {
        this.entries.delete(h);
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.entries.size;
  }

  close(): void {
    this.entries.clear();
  }
}

class SqliteDedupStore implements DedupStore {
  readonly backend = 'sqlite' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string, loadDriver: () => unknown = () => require('better-sqlite3')) {
    const Database = loadDriver() as new (
      path: string,
      opts?: { readonly?: boolean }
    ) => {
      exec(sql: string): void;
      prepare(sql: string): {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): { changes: number };
      };
      close(): void;
    };

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content_hashes (
          hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hashes_expires ON content_hashes(expires_at);
      `);
      // Additive, idempotent migration: rows written by older versions become 'committed'.
      for (const ddl of [
        "ALTER TABLE content_hashes ADD COLUMN state TEXT NOT NULL DEFAULT 'committed'",
        'ALTER TABLE content_hashes ADD COLUMN owner TEXT',
        'ALTER TABLE content_hashes ADD COLUMN unknown_since INTEGER',
      ]) {
        try {
          this.db.exec(ddl);
        } catch (err) {
          if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_hashes_state_unknown_since ON content_hashes(state, unknown_since)'
      );
      // Append-only operator audit trail; additive, so older binaries ignore it.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS unknown_resolutions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          hash_prefix TEXT NOT NULL,
          outcome TEXT NOT NULL,
          operator TEXT NOT NULL,
          note TEXT
        );
      `);
    } catch (error) {
      // A partially initialized native SQLite handle must never leak on schema/migration failure.
      try {
        this.db.close();
      } catch {
        // Preserve the original schema/migration error.
      }
      throw error;
    }
  }

  has(hash: string): boolean {
    return this.status(hash) !== null;
  }

  status(hash: string): DedupState | null {
    this.purgeExpired();
    const row = this.db.prepare('SELECT state FROM content_hashes WHERE hash = ?').get(hash) as
      | { state: DedupState }
      | undefined;
    return row ? row.state : null;
  }

  claim(hash: string, leaseMinutes: number): string | null {
    assertValidLease(leaseMinutes);
    this.purgeExpired();
    const owner = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO content_hashes(hash, expires_at, state, owner)
         VALUES(?, ?, 'pending', ?)`
      )
      .run(hash, Date.now() + leaseMinutes * 60_000, owner);
    return result.changes === 1 ? owner : null;
  }

  markUnknown(hash: string, token: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE content_hashes SET state = 'unknown', expires_at = ?, unknown_since = ?
         WHERE hash = ? AND state = 'pending' AND owner = ? AND expires_at >= ?`
      )
      .run(Number.MAX_SAFE_INTEGER, now, hash, token, now);
    return result.changes === 1;
  }

  revertUnknown(hash: string, token: string): boolean {
    const result = this.db
      .prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'unknown' AND owner = ?")
      .run(hash, token);
    return result.changes === 1;
  }

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const now = Date.now();
    const expiresAt = expiresAtForTtl(ttlMinutes, now);
    const result = this.db
      .prepare(
        `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?, unknown_since = NULL
         WHERE hash = ? AND owner = ?
           AND state = 'unknown'`
      )
      .run(expiresAt, hash, token);
    return result.changes === 1;
  }

  release(hash: string, token: string): void {
    this.db
      .prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'pending' AND owner = ?")
      .run(hash, token);
  }

  add(hash: string, ttlMinutes: number): void {
    const now = Date.now();
    const expiresAt = expiresAtForTtl(ttlMinutes, now);
    this.purgeExpired();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO content_hashes(hash, expires_at, state, owner) VALUES(?, ?, 'committed', NULL)"
      )
      .run(hash, expiresAt);
  }

  unknownStats(): { count: number; oldestAt: number | null } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, MIN(unknown_since) AS oldestAt FROM content_hashes WHERE state = 'unknown'")
      .get() as { count: number; oldestAt: number | null };
    return { count: row.count, oldestAt: row.oldestAt ?? null };
  }

  listUnknown(limit = 100): UnknownEntrySummary[] {
    const rows = this.db
      .prepare(
        "SELECT substr(hash, 1, 12) AS hashPrefix, unknown_since AS unknownSince FROM content_hashes WHERE state = 'unknown' ORDER BY unknown_since ASC LIMIT ?"
      )
      .all(normalizeLimit(limit)) as Array<{ hashPrefix: string; unknownSince: number | null }>;
    return rows.map((row) => ({ hashPrefix: row.hashPrefix, unknownSince: row.unknownSince ?? null }));
  }

  resolveUnknown(hashPrefix: string, options: ResolveUnknownOptions): ResolveUnknownResult {
    const prefix = normalizePrefix(hashPrefix);
    if (!prefix) return { ok: false, reason: 'invalid_prefix' };
    const now = options.now ?? Date.now();
    const ttlExpiry =
      options.outcome === 'stored'
        ? expiresAtForTtl(options.ttlMinutes ?? DEFAULT_RESOLVE_TTL_MINUTES, now)
        : null;
    // One immediate (write-locked) transaction: lookup, state change and audit row commit together.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          "SELECT hash, unknown_since AS unknownSince FROM content_hashes WHERE state = 'unknown' AND substr(hash, 1, ?) = ? LIMIT 2"
        )
        .all(prefix.length, prefix) as Array<{ hash: string; unknownSince: number | null }>;
      let result: ResolveUnknownResult;
      if (rows.length === 0) result = { ok: false, reason: 'not_found' };
      else if (rows.length > 1) result = { ok: false, reason: 'ambiguous' };
      else if (rows[0].unknownSince !== null && now - rows[0].unknownSince < options.minAgeMs) {
        result = { ok: false, reason: 'too_recent' };
      } else {
        const { hash } = rows[0];
        const changed =
          ttlExpiry === null
            ? this.db.prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'unknown'").run(hash)
            : this.db
                .prepare(
                  `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?, unknown_since = NULL
                   WHERE hash = ? AND state = 'unknown'`
                )
                .run(ttlExpiry, hash);
        if (changed.changes !== 1) {
          result = { ok: false, reason: 'not_found' };
        } else {
          this.db
            .prepare(
              'INSERT INTO unknown_resolutions(at, hash_prefix, outcome, operator, note) VALUES(?, ?, ?, ?, ?)'
            )
            .run(now, hash.slice(0, 12), options.outcome, normalizeOperator(options.operator), normalizeNote(options.note));
          result = { ok: true, hashPrefix: hash.slice(0, 12), outcome: options.outcome };
        }
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  listResolutions(limit = 100): ResolutionRecord[] {
    const rows = this.db
      .prepare(
        'SELECT at, hash_prefix AS hashPrefix, outcome, operator, note FROM unknown_resolutions ORDER BY id DESC LIMIT ?'
      )
      .all(normalizeLimit(limit)) as Array<{
      at: number;
      hashPrefix: string;
      outcome: UnknownOutcome;
      operator: string;
      note: string | null;
    }>;
    return rows.map((row) => ({ ...row, note: row.note ?? null }));
  }

  purgeExpired(): number {
    const result = this.db
      .prepare("DELETE FROM content_hashes WHERE state != 'unknown' AND expires_at < ?")
      .run(Date.now());
    return result.changes as number;
  }

  size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM content_hashes').get() as {
      c: number;
    };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}

function normalizePrefix(value: string): string | null {
  const prefix = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return HASH_PREFIX_PATTERN.test(prefix) ? prefix : null;
}

function normalizeLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
}

/** Audit fields are bounded and stripped of control characters (log/terminal injection). */
function normalizeOperator(value: string): string {
  const cleaned = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
  return cleaned || 'unknown';
}

function normalizeNote(value: string | undefined): string | null {
  if (value === undefined) return null;
  const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return cleaned || null;
}

/** Claim leases must be exactly representable and never exceed the protocol's 24-hour bound. */
function assertValidLease(leaseMinutes: number): void {
  const milliseconds = leaseMinutesToMs(leaseMinutes, 'lease');
  if (milliseconds > MAX_EFFECTIVE_LEASE_MS) {
    throw new RangeError(`[DedupStore] lease must not exceed ${MAX_EFFECTIVE_LEASE_MS} milliseconds`);
  }
}

/** Deduplication TTLs may exceed the claim cap, but the absolute expiry must remain a safe integer. */
function expiresAtForTtl(ttlMinutes: number, now = Date.now()): number {
  const expiresAt = now + leaseMinutesToMs(ttlMinutes, 'ttlMinutes');
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError('[DedupStore] absolute TTL expiry exceeds the safe integer timestamp range');
  }
  return expiresAt;
}

/** In-process store (tests, or explicit opt-out of persistence). */
export function createMemoryDedupStore(): DedupStore {
  return new MemoryDedupStore();
}

export interface CreateDedupStoreOptions {
  /**
   * Fail closed: throw instead of falling back to the in-memory store when SQLite is unavailable.
   * Required in NODE_ENV=production, or when DEDUP_REQUIRE_SQLITE=1|true. Production cannot
   * override this with requireSqlite:false. The in-memory store has no cross-process or restart persistence.
   */
  requireSqlite?: boolean;
  /** Test seam: replaces `require('better-sqlite3')`. */
  loadDriver?: () => unknown;
}

export function createDedupStore(explicitPath?: string, options: CreateDedupStoreOptions = {}): DedupStore {
  const requireSqlite =
    process.env.NODE_ENV === 'production' ||
    options.requireSqlite === true ||
    ['1', 'true'].includes((process.env.DEDUP_REQUIRE_SQLITE ?? '').toLowerCase());
  const configuredDbPath = process.env.DEDUP_DB_PATH?.trim();
  const configuredDataDir = process.env.DATA_DIR?.trim();
  const configuredEnvPath = configuredDbPath ||
    (configuredDataDir ? join(configuredDataDir, '.data', 'auto-memory-dedup.sqlite') : undefined);
  const configuredPath = explicitPath || configuredEnvPath;
  const path =
    configuredPath ||
    join(process.cwd(), '.data', 'auto-memory-dedup.sqlite');

  if (process.env.NODE_ENV === 'production' && (!configuredPath || !isAbsolute(configuredPath))) {
    throw new Error(
      '[DedupStore] production requires an absolute DEDUP_DB_PATH or DATA_DIR; refusing a cwd-dependent SQLite location'
    );
  }

  try {
    return new SqliteDedupStore(path, options.loadDriver);
  } catch (err) {
    if (requireSqlite) {
      throw new Error(
        `[DedupStore] SQLite is required (production or DEDUP_REQUIRE_SQLITE) but unavailable: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    console.error(
      '[DedupStore] SQLite unavailable, using in-memory fallback (no cross-process dedup):',
      err instanceof Error ? err.message : err
    );
    return new MemoryDedupStore();
  }
}