import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDedupStore } from '../src/lib/dedup-store.js';

const require = createRequire(import.meta.url);
const RealDatabase = require('better-sqlite3') as new (
  path: string,
  options?: { timeout?: number }
) => {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

function seedLegacyDatabase(dbPath: string): void {
  const legacy = new RealDatabase(dbPath);
  try {
    legacy.exec('CREATE TABLE content_hashes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO content_hashes(hash, expires_at) VALUES(?, ?)').run(
      'legacy-row-preserved',
      1_700_000_000_000
    );
  } finally {
    legacy.close();
  }
}

function expectLegacyStatePreserved(dbPath: string): void {
  const verify = new RealDatabase(dbPath);
  try {
    const columns = verify.prepare('PRAGMA table_info(content_hashes)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(['hash', 'expires_at']);

    const rows = verify.prepare('SELECT hash, expires_at FROM content_hashes').all() as Array<{
      hash: string;
      expires_at: number;
    }>;
    expect(rows).toEqual([{ hash: 'legacy-row-preserved', expires_at: 1_700_000_000_000 }]);

    const indexes = verify.prepare("PRAGMA index_list('content_hashes')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).not.toContain('idx_hashes_expires');
    expect(indexes.map((index) => index.name)).not.toContain('idx_hashes_state_unknown_since');

    const auditTable = verify.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'unknown_resolutions'"
    ).all();
    expect(auditTable).toHaveLength(0);
  } finally {
    verify.close();
  }
}

describe('SQLite schema migration atomicity', () => {
  it('rolls back all DDL, indexes, and audit tables when a later additive migration step fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-migration-atomic-'));
    const dbPath = join(dir, 'dedup.sqlite');
    seedLegacyDatabase(dbPath);

    const failingDriver = () => class {
      private readonly db: InstanceType<typeof RealDatabase>;

      constructor(path: string, options?: { timeout?: number }) {
        this.db = new RealDatabase(path, options);
      }

      exec(sql: string): void {
        if (sql.includes('ALTER TABLE content_hashes ADD COLUMN owner TEXT')) {
          throw new Error('injected migration failure');
        }
        this.db.exec(sql);
      }

      prepare(sql: string) {
        return this.db.prepare(sql);
      }

      close(): void {
        this.db.close();
      }
    };

    try {
      expect(() =>
        createDedupStore(dbPath, { requireSqlite: true, loadDriver: failingDriver })
      ).toThrow(/injected migration failure/);

      expectLegacyStatePreserved(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back the complete migration when COMMIT itself fails after all DDL succeeds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-migration-commit-'));
    const dbPath = join(dir, 'dedup.sqlite');
    seedLegacyDatabase(dbPath);

    const failingCommitDriver = () => class {
      private readonly db: InstanceType<typeof RealDatabase>;

      constructor(path: string, options?: { timeout?: number }) {
        this.db = new RealDatabase(path, options);
      }

      exec(sql: string): void {
        if (sql.trim() === 'COMMIT') {
          throw new Error('injected late COMMIT failure');
        }
        this.db.exec(sql);
      }

      prepare(sql: string) {
        return this.db.prepare(sql);
      }

      close(): void {
        this.db.close();
      }
    };

    try {
      expect(() =>
        createDedupStore(dbPath, { requireSqlite: true, loadDriver: failingCommitDriver })
      ).toThrow(/injected late COMMIT failure/);

      expectLegacyStatePreserved(dbPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
