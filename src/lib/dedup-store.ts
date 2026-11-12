// Persistent content-hash store for auto-memory deduplication (two-phase).
//
//   pending   = reservation held by ONE in-flight interaction; short lease.
//   committed = the save is durable; retained for the dedup window.
//
// Why two phases: a single long-TTL claim turns a crash between claim and save
// into silent data loss (the interaction is rejected as "duplicate" although
// nothing was stored). A pending claim expires after its lease, a committed
// entry only exists after the brain acknowledged the save.
//
// Uses better-sqlite3 when available; falls back to in-process Map.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export type DedupState = 'pending' | 'committed';

export interface DedupStore {
  /** Which backend is actually in use (observability: memory means no cross-process dedup). */
  readonly backend: 'sqlite' | 'memory';
  /** True when a committed entry or a live pending reservation exists. */
  has(hash: string): boolean;
  /** State of the live entry for `hash`, or null. */
  status(hash: string): DedupState | null;
  /** Atomically reserve `hash` for `leaseMinutes`. Returns an owner token, or null when a live entry exists. */
  claim(hash: string, leaseMinutes: number): string | null;
  /**
   * Promote the caller's pending reservation to committed for `ttlMinutes`.
   * A committed entry exists afterwards in every case (the save is durable);
   * returns false when the reservation had been lost in the meantime.
   */
  commit(hash: string, token: string, ttlMinutes: number): boolean;
  /** Deletes the entry only if it is still the caller's PENDING reservation. */
  release(hash: string, token: string): void;
  /** Upserts a committed entry. */
  add(hash: string, ttlMinutes: number): void;
  purgeExpired(): number;
  size(): number;
  close(): void;
}

interface MemoryEntry {
  exp: number;
  state: DedupState;
  owner: string | null;
}

class MemoryDedupStore implements DedupStore {
  readonly backend = 'memory' as const;
  private readonly entries = new Map<string, MemoryEntry>();

  private live(hash: string): MemoryEntry | undefined {
    const e = this.entries.get(hash);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
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
    if (this.live(hash)) return null;
    const owner = randomUUID();
    this.entries.set(hash, { exp: Date.now() + leaseMinutes * 60_000, state: 'pending', owner });
    return owner;
  }

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const e = this.entries.get(hash);
    const owned = e !== undefined && e.state === 'pending' && e.owner === token;
    this.entries.set(hash, { exp: Date.now() + ttlMinutes * 60_000, state: 'committed', owner: null });
    return owned;
  }

  release(hash: string, token: string): void {
    const e = this.entries.get(hash);
    if (e && e.state === 'pending' && e.owner === token) this.entries.delete(hash);
  }

  add(hash: string, ttlMinutes: number): void {
    this.entries.set(hash, { exp: Date.now() + ttlMinutes * 60_000, state: 'committed', owner: null });
  }

  purgeExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [h, e] of this.entries) {
      if (now > e.exp) {
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
    ]) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
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

  commit(hash: string, token: string, ttlMinutes: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?
         WHERE hash = ? AND state = 'pending' AND owner = ?`
      )
      .run(Date.now() + ttlMinutes * 60_000, hash, token);
    if (result.changes === 1) return true;
    this.add(hash, ttlMinutes); // lease was lost, but the save is durable: still record it
    return false;
  }

  release(hash: string, token: string): void {
    this.db
      .prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'pending' AND owner = ?")
      .run(hash, token);
  }

  add(hash: string, ttlMinutes: number): void {
    this.db
      .prepare(
        `INSERT INTO content_hashes(hash, expires_at, state, owner) VALUES(?, ?, 'committed', NULL)
         ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at, state = 'committed', owner = NULL`
      )
      .run(hash, Date.now() + ttlMinutes * 60_000);
  }

  purgeExpired(): number {
    const result = this.db
      .prepare('DELETE FROM content_hashes WHERE expires_at < ?')
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

/** In-process store (tests, or explicit opt-out of persistence). */
export function createMemoryDedupStore(): DedupStore {
  return new MemoryDedupStore();
}

export interface CreateDedupStoreOptions {
  /**
   * Fail closed: throw instead of falling back to the in-memory store when SQLite is unavailable.
   * Defaults to env DEDUP_REQUIRE_SQLITE=1|true. The in-memory store gives NO cross-process or
   * restart-surviving deduplication, so environments that rely on it must opt in to being strict.
   */
  requireSqlite?: boolean;
  /** Test seam: replaces `require('better-sqlite3')`. */
  loadDriver?: () => unknown;
}

export function createDedupStore(explicitPath?: string, options: CreateDedupStoreOptions = {}): DedupStore {
  const requireSqlite =
    options.requireSqlite ?? ['1', 'true'].includes((process.env.DEDUP_REQUIRE_SQLITE ?? '').toLowerCase());
  const path =
    explicitPath ||
    process.env.DEDUP_DB_PATH ||
    join(process.env.DATA_DIR || process.cwd(), '.data', 'auto-memory-dedup.sqlite');

  try {
    return new SqliteDedupStore(path, options.loadDriver);
  } catch (err) {
    if (requireSqlite) {
      throw new Error(
        `[DedupStore] SQLite is required (DEDUP_REQUIRE_SQLITE) but unavailable: ${err instanceof Error ? err.message : String(err)}`,
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
