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
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_hashes_expires ON content_hashes(expires_at);
```

This store is **not** the Brain database; it only prevents duplicate auto-saves inside the Hub process fleet when a shared DATA_DIR is used.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Defined real memory domain; added local dedup table | engineering |
