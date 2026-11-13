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
   * The caller invokes this only after the Brain confirms a durable save. Persist that
   * fact even if the original lease expired and a successor claimed the same hash.
   * Returns false when the caller no longer owned the pending reservation.
   */
  commit(hash: string, token: string, ttlMinutes: number): boolean;
  /** Deletes the entry only if it is still the caller's PENDING reservation. */
  release(hash: string, token: string): void;
  /** Records a committed entry if free; a token marks post-save recovery and makes durable success authoritative. */
  add(hash: string, ttlMinutes: number, token?: string): void;
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
    assertValidMinutes('ttlMinutes', ttlMinutes);
    const e = this.live(hash);
    const owned = e?.state === 'pending' && e.owner === token;

    // This method is called only after the Brain save was acknowledged.
    // Durable success outranks any still-live pending lease for the same hash:
    // retaining that lease after a confirmed save could lose the committed marker
    // if the successor later fails before its own save.
    this.entries.set(hash, {
      exp: Date.now() + ttlMinutes * 60_000,
      state: 'committed',
      owner: null,
    });
    return Boolean(owned);
  }

  release(hash: string, token: string): void {
    const e = this.entries.get(hash);
    if (e && e.state === 'pending' && e.owner === token) this.entries.delete(hash);
  }

  add(hash: string, ttlMinutes: number, token?: string): void {
    assertValidMinutes('ttlMinutes', ttlMinutes);
    const current = this.live(hash);
    if (current && !token) return;

    // A token is supplied only by the post-save recovery path. The Brain has
    // already acknowledged persistence, so the committed fact must supersede
    // a successor lease just as commit() does.
    if (token || !current) {
      this.entries.set(hash, { exp: Date.now() + ttlMinutes * 60_000, state: 'committed', owner: null });
    }
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
      ]) {
        try {
          this.db.exec(ddl);
        } catch (err) {
          if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
        }
      }
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
    assertValidMinutes('ttlMinutes', ttlMinutes);
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    const result = this.db
      .prepare(
        `UPDATE content_hashes SET state = 'committed', owner = NULL, expires_at = ?
         WHERE hash = ? AND state = 'pending' AND owner = ?`
      )
      .run(expiresAt, hash, token);
    if (result.changes === 1) return true;

    // The Brain save was acknowledged. Record that durable fact even if this
    // lease expired and a successor claimed the hash in the meantime. The
    // UPSERT is atomic and prevents a later failed successor from erasing
    // knowledge that the earlier request was already persisted.
    this.db
      .prepare(
        `INSERT INTO content_hashes(hash, expires_at, state, owner)
         VALUES(?, ?, 'committed', NULL)
         ON CONFLICT(hash) DO UPDATE SET
           expires_at = excluded.expires_at,
           state = 'committed',
           owner = NULL`
      )
      .run(hash, expiresAt);
    return false;
  }

  release(hash: string, token: string): void {
    this.db
      .prepare("DELETE FROM content_hashes WHERE hash = ? AND state = 'pending' AND owner = ?")
      .run(hash, token);
  }

  add(hash: string, ttlMinutes: number, token?: string): void {
    assertValidMinutes('ttlMinutes', ttlMinutes);
    this.purgeExpired();
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    if (!token) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO content_hashes(hash, expires_at, state, owner) VALUES(?, ?, 'committed', NULL)"
        )
        .run(hash, expiresAt);
      return;
    }

    // The token is passed only after a confirmed Brain save. Preserve that
    // durable fact even if another pending lease has since taken ownership.
    this.db
      .prepare(
        `INSERT INTO content_hashes(hash, expires_at, state, owner)
         VALUES(?, ?, 'committed', NULL)
         ON CONFLICT(hash) DO UPDATE SET
           expires_at = excluded.expires_at,
           state = 'committed',
           owner = NULL`
      )
      .run(hash, expiresAt);
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

/** A non-finite or non-positive TTL is bound as NULL by SQLite (NOT NULL violation) or never expires. */
function assertValidMinutes(name: string, minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new RangeError(`[DedupStore] ${name} must be a positive finite number of minutes, got ${minutes}`);
  }
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