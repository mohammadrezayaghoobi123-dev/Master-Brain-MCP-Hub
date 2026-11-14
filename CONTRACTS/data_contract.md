# Data Contract — Memory Domain

> **REGEL:** Keine stillen Änderungen an Typen/Feldern.
> Änderungen nur mit: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.2.0  
**Letzte Änderung:** 2026-11-14

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

SQLite is the durable, cross-process deduplication backend. In production, SQLite is required; the in-process memory backend is non-durable and is intended only for tests or an explicitly configured non-production use. All Hub processes that must coordinate duplicate auto-saves must use the same SQLite database file.

The following describes the **current logical schema after additive migrations** (not a requirement that every column be present in the initial CREATE TABLE statement):

```sql
CREATE TABLE content_hashes (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'committed', -- pending | unknown | committed
  owner TEXT,
  unknown_since INTEGER
);

CREATE INDEX idx_hashes_expires
  ON content_hashes(expires_at);

CREATE INDEX idx_hashes_state_unknown_since
  ON content_hashes(state, unknown_since);

CREATE TABLE unknown_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  hash_prefix TEXT NOT NULL,
  outcome TEXT NOT NULL, -- not_stored | stored
  operator TEXT NOT NULL,
  note TEXT
);
```

The database path is configured explicitly (production requires a persistent SQLite path); the conventional location is `$DATA_DIR/.data/auto-memory-dedup.sqlite`.

### State semantics and invariants

- **`pending`**: a time-bounded reservation created by `claim`, owned by one in-flight interaction. Its `expires_at` is the lease deadline. Only the matching owner may release it.
- **`unknown`**: a durable quarantine entered before dispatching a Brain write. `markUnknown` requires the matching owner and a still-valid pending lease. The state does not expire: its timestamp is recorded in `unknown_since`, and the implementation stores a non-expiring sentinel in `expires_at`. A claim or ordinary add must never replace an UNKNOWN row.
- **`committed`**: a Brain save was positively acknowledged, or an operator explicitly resolved an UNKNOWN entry as `stored`. Its `expires_at` is the deduplication-window deadline; after that deadline it may be claimed again.
- Existing rows from the earlier schema are migrated additively with `state='committed'`; new nullable columns are added without discarding existing hash/expiry data.
- Expired non-UNKNOWN rows are logically absent to status checks and may be atomically replaced by a new claim. Physical cleanup is performed by the expiry purge path.

### Owner-checked transitions

- `pending → unknown`: only `markUnknown(hash, owner)` may perform this transition, and only while that owner's lease remains valid.
- `pending → absent`: `release(hash, owner)` deletes only the matching owner's PENDING row.
- `unknown → absent`: `revertUnknown(hash, owner)` is allowed only for the matching owner when the request is positively known to have **not** been dispatched. This is not a general retry mechanism.
- `unknown → committed`: `commit(hash, owner, ttl)` updates only the matching owner's UNKNOWN row. A stale owner cannot commit or overwrite another owner's reservation.
- `unknown → absent` or `unknown → committed` may also be performed by the operator-only resolution workflow, after out-of-band verification, using a unique hash prefix. The resolution and its audit row are written in one immediate SQLite transaction.
- An UNKNOWN row blocks automatic re-claim indefinitely until one of those explicit, owner-checked or operator-mediated resolution paths succeeds. Lease expiry alone is never evidence that the external write did not happen.

### Operator resolution and audit

The operator CLI supports listing quarantined rows, resolving one uniquely identified UNKNOWN row as `not_stored` or `stored`, and listing resolution history. It is a local CLI operation, **not an MCP tool**. Resolution has a minimum-age guard; elapsed time is only a delay and is not proof of the external outcome. The operator must establish the outcome out of band.

The `unknown_resolutions` table records timestamp, hash prefix, outcome, operator identity, and optional note. The application writes resolution and audit record atomically. This is an application-level append-only audit trail; it is **not tamper-proof** against direct database modification or host compromise.

This store is **not** the Brain database; it coordinates duplicate auto-saves only among Hub processes that share the same SQLite file. It does not provide exactly-once delivery, and it cannot independently establish whether an ambiguous external request was persisted.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Defined real memory domain; added local dedup table | engineering |
| 2026-11-14 | Aligned dedup schema, UNKNOWN quarantine, owner-checked transitions, operator resolution, and audit semantics with PR17 | explicit user authorization |
