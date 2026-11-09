// Persistent content-hash store for auto-memory deduplication.
// Uses better-sqlite3 when available; falls back to in-process Map.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export interface DedupStore {
  has(hash: string): boolean;
  /** Returns the reservation's expiry token, or null when another claim is active. */
  claim(hash: string, ttlMinutes: number): number | null;
  /** Releases only the exact reservation returned by claim(). */
  release(hash: string, reservationToken: number): void;
  add(hash: string, ttlMinutes: number): void;
  purgeExpired(): number;
  size(): number;
  close(): void;
}

class MemoryDedupStore implements DedupStore {
  private readonly entries = new Map<string, number>();

  has(hash: string): boolean {
    const exp = this.entries.get(hash);
    if (exp === undefined) return false;
    if (Date.now() > exp) {
      this.entries.delete(hash);
      return false;
    }
    return true;
  }

  claim(hash: string, ttlMinutes: number): number | null {
    if (this.has(hash)) return null;
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    this.entries.set(hash, expiresAt);
    return expiresAt;
  }

  release(hash: string, reservationToken: number): void {
    if (this.entries.get(hash) === reservationToken) this.entries.delete(hash);
  }

  add(hash: string, ttlMinutes: number): void {
    this.entries.set(hash, Date.now() + ttlMinutes * 60_000);
  }

  purgeExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [h, exp] of this.entries) {
      if (now > exp) {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (
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
  }

  has(hash: string): boolean {
    this.purgeExpired();
    const row = this.db.prepare('SELECT 1 AS ok FROM content_hashes WHERE hash = ?').get(hash) as
      | { ok: number }
      | undefined;
    return Boolean(row);
  }

  claim(hash: string, ttlMinutes: number): number | null {
    this.purgeExpired();
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    const result = this.db
      .prepare('INSERT OR IGNORE INTO content_hashes(hash, expires_at) VALUES(?, ?)')
      .run(hash, expiresAt);
    return result.changes === 1 ? expiresAt : null;
  }

  release(hash: string, reservationToken: number): void {
    this.db
      .prepare('DELETE FROM content_hashes WHERE hash = ? AND expires_at = ?')
      .run(hash, reservationToken);
  }

  add(hash: string, ttlMinutes: number): void {
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    this.db
      .prepare(
        `INSERT INTO content_hashes(hash, expires_at) VALUES(?, ?)
         ON CONFLICT(hash) DO UPDATE SET expires_at = excluded.expires_at`
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

export function createDedupStore(explicitPath?: string): DedupStore {
  const path =
    explicitPath ||
    process.env.DEDUP_DB_PATH ||
    join(process.env.DATA_DIR || process.cwd(), '.data', 'auto-memory-dedup.sqlite');

  try {
    return new SqliteDedupStore(path);
  } catch (err) {
    console.error(
      '[DedupStore] SQLite unavailable, using in-memory fallback:',
      err instanceof Error ? err.message : err
    );
    return new MemoryDedupStore();
  }
}
