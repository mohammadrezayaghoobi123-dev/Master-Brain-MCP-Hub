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
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
};

describe('SQLite schema migration atomicity', () => {
  it('rolls back earlier DDL when a later additive migration step fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-migration-atomic-'));
    const dbPath = join(dir, 'dedup.sqlite');
    const legacy = new RealDatabase(dbPath);
    legacy.exec('CREATE TABLE content_hashes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    legacy.close();

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

      const verify = new RealDatabase(dbPath);
      try {
        const columns = verify.prepare('PRAGMA table_info(content_hashes)').all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).not.toContain('state');
        expect(columns.map((column) => column.name)).toEqual(['hash', 'expires_at']);
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
