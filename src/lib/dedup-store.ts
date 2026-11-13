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
import { dirname, join } from 'node:path';
import { leaseMinutesToMs, MAX_EFFECTIVE_LEASE_MS } from './time-budget.js';

const require = createRequire(import.meta.url);

export type DedupState = 'pending' | 'unknown' | 'committed';

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
  /** Commit only the matching current owner; stale owners must never overwrite another claim. */
  commit(hash: string, token: string, ttlMinutes: number): boolean;
  /** Deletes the entry only if it is still the caller's PENDING reservation. UNKNOWN is never released. */
  release(hash: string, token: string): void;
  /** Record a committed entry only if free (no token) or still owned by the supplied token. */
  add(hash: string, ttlMinutes: number, token?: string): void;
  /** Safe operational summary of quarantined UNKNOWN rows; never exposes hashes or owner tokens. */
  unknownStats(): { count: number; oldestAt: number | null };
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

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const expiresAt = expiresAtForTtl(ttlMinutes);
    const e = this.live(hash);
    if (!e || (e.state !== 'pending' && e.state !== 'unknown') || e.owner !== token) {
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

  add(hash: string, ttlMinutes: number, token?: string): void {
    const expiresAt = expiresAtForTtl(ttlMinutes);
    const current = this.live(hash);
    if (token) {
      if (!current || current.owner !== token || current.state !== 'pending') {
        return;
      }
    } else if (current) {
      return;
    }
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

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const now = Date.now();
    const expiresAt = expiresAtForTtl(ttlMinutes, now);
    const result = this.db
      .prepare(
        `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?, unknown_since = NULL
         WHERE hash = ? AND owner = ?
           AND (state = 'unknown' OR (state = 'pending' AND expires_at >= ?))`
      )
      .run(expiresAt, hash, token, now);
    return result.changes === 1;
  }

  release(hash: string, token: string): void {
    this.db
      .prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'pending' AND owner = ?")
      .run(hash, token);
  }

  add(hash: string, ttlMinutes: number, token?: string): void {
    const now = Date.now();
    const expiresAt = expiresAtForTtl(ttlMinutes, now);
    this.purgeExpired();
    if (!token) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO content_hashes(hash, expires_at, state, owner) VALUES(?, ?, 'committed', NULL)"
        )
        .run(hash, expiresAt);
      return;
    }

    this.db
      .prepare(
        `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?, unknown_since = NULL
         WHERE hash = ? AND owner = ? AND state = 'pending'`
      )
      .run(expiresAt, hash, token);
  }

  unknownStats(): { count: number; oldestAt: number | null } {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, MIN(unknown_since) AS oldestAt FROM content_hashes WHERE state = 'unknown'")
      .get() as { count: number; oldestAt: number | null };
    return { count: row.count, oldestAt: row.oldestAt ?? null };
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
  const path =
    explicitPath ||
    process.env.DEDUP_DB_PATH ||
    join(process.env.DATA_DIR || process.cwd(), '.data', 'auto-memory-dedup.sqlite');

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