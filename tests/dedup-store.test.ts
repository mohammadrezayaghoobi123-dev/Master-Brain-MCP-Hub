import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDedupStore } from '../src/lib/dedup-store.js';

describe('SQLiteDedupStore integration', () => {
  it('opens a real SQLite database and persists hashes across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-dedup-'));
    const dbPath = join(dir, 'dedup.sqlite');

    try {
      const first = createDedupStore(dbPath);
      try {
        first.add('integration-hash', 30);
        expect(first.has('integration-hash')).toBe(true);
        expect(first.size()).toBe(1);
      } finally {
        first.close();
      }

      const reopened = createDedupStore(dbPath);
      try {
        expect(reopened.has('integration-hash')).toBe(true);
        expect(reopened.size()).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed instead of falling back to memory when SQLite is required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-dedup-fail-'));
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file');
    const previous = process.env.DEDUP_REQUIRE_SQLITE;
    process.env.DEDUP_REQUIRE_SQLITE = '1';
    try {
      expect(() => createDedupStore(join(blocker, 'blocked.sqlite'))).toThrow(
        /SQLite is required but unavailable; refusing in-memory fallback/
      );
    } finally {
      if (previous === undefined) delete process.env.DEDUP_REQUIRE_SQLITE;
      else process.env.DEDUP_REQUIRE_SQLITE = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  
  it('fails closed by default in production even if DEDUP_REQUIRE_SQLITE is not enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-brain-dedup-production-'));
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file');
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRequire = process.env.DEDUP_REQUIRE_SQLITE;
    process.env.NODE_ENV = 'production';
    process.env.DEDUP_REQUIRE_SQLITE = '0';
    try {
      expect(() => createDedupStore(join(blocker, 'blocked.sqlite'), { requireSqlite: false })).toThrow(
        /SQLite is required/
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousRequire === undefined) delete process.env.DEDUP_REQUIRE_SQLITE;
      else process.env.DEDUP_REQUIRE_SQLITE = previousRequire;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
