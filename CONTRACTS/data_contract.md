# Data Contract — Memory Domain

> **REGEL:** Keine stillen Änderungen an Typen/Feldern.
> Änderungen nur mit: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.1.0  
**Letzte Änderung:** 2026-11-08

---

## MemoryType (enum)

```
decision | fix | learning | pattern | preference | config | error | context | conversation
```

Canonical source: `src/types/index.ts` → `MEMORY_TYPES`.

---

## BrainEntry

| Feld | Typ | Pflicht | Notes |
|------|-----|---------|-------|
| id | string (UUID) | yes (server) | assigned by backend |
| type | MemoryType | yes | |
| content | string ≤ 10000 | yes | |
| summary | string ≤ 200 | no | |
| tags | string[] 1–10 | yes | lowercase preferred |
| source | MemorySource | yes | |
| timestamp | ISO-8601 string | yes (server) | never a Date object on the wire |
| metadata | object | no | free-form; Auto-Memory stores confidence, contentHash |

## MemorySource

| Feld | Typ | Pflicht |
|------|-----|---------|
| tool | claude-code \| codex \| cursor \| api \| manual \| auto-memory | yes |
| session_id | string | no |
| project | string | no |
| file | string | no |
| user_id | string | no |

---

## Local dedup store (MCP Hub only)

SQLite table `content_hashes` (path: `$DATA_DIR/.data/auto-memory-dedup.sqlite`):

```sql
CREATE TABLE content_hashes (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'committed', -- pending | committed
  owner TEXT
);
CREATE INDEX idx_hashes_expires ON content_hashes(expires_at);
```

- `pending`: a time-bounded reservation owned by one in-flight interaction.
- `committed`: the Brain save was acknowledged; the longer deduplication TTL applies.
- A release is conditional on both `state='pending'` and the matching owner token.
- After a confirmed Brain save, `commit` / owner-aware recovery records `committed` even if the original lease expired and a successor claimed the same hash. This preserves the durable fact if the successor later fails before saving.

This store is **not** the Brain database; it coordinates duplicate auto-saves only among Hub processes that share the same SQLite file.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Defined real memory domain; added local dedup table | engineering |