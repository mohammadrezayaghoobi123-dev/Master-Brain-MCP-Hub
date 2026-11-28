# Data Contract — Memory Domain

> **REGEL:** Keine stillen Änderungen an Typen/Feldern.
> Änderungen nur mit: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.2.0  
**Letzte Änderung:** 2026-11-28

---

## MemoryType (enum)

```
decision | fix | learning | pattern | preference | config | error | context | conversation
```

Canonical source: `src/types/index.ts` → `MEMORY_TYPES`.

---

## BrainEntry

| Field | Type | Required | Notes |
|------|-----|---------|-------|
| id | string (UUID) | yes (server) | assigned by backend |
| type | MemoryType | yes | |
| content | string ≤ 10000 | yes | |
| summary | string ≤ 200 | no | Auto-Memory uses ≤ 180 |
| tags | string[] 1–10 | yes | lowercase / hyphenated preferred |
| source | MemorySource | yes | |
| timestamp | ISO-8601 string | yes (server) | never a Date object on the wire |
| metadata | object | no | free-form; see Auto-Memory metadata below |

## MemorySource

| Field | Type | Required |
|------|-----|---------|
| tool | claude-code \| codex \| cursor \| api \| manual \| auto-memory | yes |
| session_id | string | no |
| project | string | no |
| file | string | no |
| user_id | string | no |

---

## Auto-Memory metadata (Hub → Brain on save)

When `source.tool === "auto-memory"`, metadata SHOULD include:

| Field | Type | Notes |
|------|------|-------|
| confidence | number 0–1 | classifier calibrated score |
| contentHash | string | SHA of request+response used for local dedup + Idempotency-Key |
| effectiveMinConfidence | number | max(config.min, hard floor 0.75) at save time |
| originalRequest | string ≤ 500 | truncated request for audit |
| context | string | optional classifier context |

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

This store is **not** the Brain database; it only prevents duplicate auto-saves inside the Hub process fleet when a shared DATA_DIR is used. Brain-side dedup for writes is via `Idempotency-Key` (see api_contract v1.2.0).

---

## Changelog

| Date | Change | Approved by |
|------|--------|-------------|
| 2026-11-08 | Defined real memory domain; added local dedup table | engineering |
| 2026-11-28 | v1.2.0: Auto-Memory metadata fields; link to Idempotency-Key | engineering |
