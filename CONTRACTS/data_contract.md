# Data Contract — Memory Domain

> **RULE:** No silent changes to domain fields or persistence semantics.
> Contract changes require explicit approval: `ÄNDERUNG ERLAUBT: ...`

**Version:** 1.2.0  
**Last updated:** 2026-11-14

---

## MemoryType

Canonical source: `src/types/index.ts` → `MEMORY_TYPES`.

```
decision | fix | learning | pattern | preference | config | error | context | conversation
```

## BrainEntry

| Field | Type | Requirement | Notes |
|---|---|---|---|
| id | string (UUID) | required from server | assigned by Backend |
| type | MemoryType | required | canonical enum above |
| content | string ≤ 10000 | required | |
| summary | string ≤ 200 | optional | |
| tags | string[] (1–10) | required | lowercase preferred |
| source | MemorySource | required | |
| timestamp | ISO-8601 string | required from server | never a Date object on the wire |
| metadata | object | optional | free-form; Auto-Memory stores confidence, contentHash and bounded context |

### MemorySource

| Field | Type | Requirement |
|---|---|---|
| tool | claude-code | codex | cursor | api | manual | auto-memory | required |
| session_id | string | optional |
| project | string | optional |
| file | string | optional |
| user_id | string | optional |

The Hub's response validator checks the structural fields, supported enum values, timestamp parseability, and optional-field types. Backend compatibility and all semantic constraints above must still be verified against the deployed Backend; a successful Hub CI run does not establish that runtime contract.

---

## Hub-local deduplication store

This SQLite database belongs to the MCP Hub. It is **not** the Brain database. It coordinates Auto-Memory duplicate suppression only among Hub processes sharing the same SQLite file.

### Current schema

```sql
CREATE TABLE content_hashes (
  hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'committed', -- pending | unknown | committed
  owner TEXT,
  unknown_since INTEGER
);
CREATE INDEX idx_hashes_expires ON content_hashes(expires_at);
CREATE INDEX idx_hashes_state_unknown_since
  ON content_hashes(state, unknown_since);
```

Existing rows from the earlier schema are migrated additively and default to `committed`. The migration adds `state`, `owner`, and `unknown_since`; it does not reinterpret historical rows as in-flight writes.

### State machine and ownership

- `pending`: pre-dispatch reservation owned by one in-flight interaction. It expires after the effective claim lease.
- `unknown`: durable quarantine entered immediately before the external Brain POST. It is non-expiring, excluded from expiry purge, and blocks automatic retry.
- `committed`: the Brain save was confirmed by a valid response; retained for the configured deduplication window. It is not permanent deduplication.

Allowed owner-checked transitions:

| Operation | Required current state | Ownership condition | Result |
|---|---|---|---|
| `claim` | no live row | creates a new random owner | `pending` |
| `markUnknown` | `pending` | exact owner token and unexpired lease | `unknown` |
| `revertUnknown` | `unknown` | exact owner token; caller must have positive evidence the request was not dispatched | row deleted |
| `commit` | `unknown` | exact owner token | `committed` with dedup TTL |
| `release` | `pending` | exact owner token | row deleted |
| `add` | no live row | ownerless insert-only operation | `committed` |

A stale owner cannot commit, release, or revert another owner's row. A confirmed save that cannot be finalized locally remains `unknown`; the implementation does not use an owner-blind UPSERT to overwrite quarantine.

### Failure and retry semantics

1. The Hub must persist `unknown` before dispatching the Brain POST. If that transition cannot be confirmed, it must not send the POST.
2. Only positively identified pre-dispatch connection-establishment failures (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) are eligible for owner-checked `unknown` reversion in the current implementation.
3. Timeouts, connection resets, HTTP error responses, and malformed or unreadable success responses remain `unknown` because the Backend may have processed the write. **Known gap at PR5 HEAD:** Fetch still follows redirects by default for writes; a transport failure on a redirected second hop can be misclassified as pre-dispatch. PR #10 proposes `redirect: 'error'` for non-GET requests, but that fix is not yet part of PR5 HEAD.
4. There is no operator reconciliation API in this version. An unresolved `unknown` can block the same content indefinitely. This is a deliberate safety-over-liveness policy, not a claim of exactly-once persistence.
5. The Hub sends an `Idempotency-Key` header on Brain saves, but Backend support, key scope, retention, and replay semantics are **UNVERIFIED**. The header alone provides no idempotency guarantee.
6. After the committed deduplication window expires, the same content hash may be saved again.

### Operational constraints

- Production requires SQLite and an absolute database path supplied through `DEDUP_DB_PATH`, `DATA_DIR`, or the explicit store-constructor path; cwd-dependent and relative paths are rejected.
- In-memory fallback is not suitable for production: it does not survive restart and does not coordinate across processes.
- `unknownStats()` exposes only the count and oldest timestamp of quarantined rows; it does not expose hashes or owner tokens.
- SQLite operations use synchronous `better-sqlite3` calls. Busy-lock behavior and event-loop impact have not yet been benchmarked under production contention.

---

## Verification boundary

Hub CI validates the Hub implementation and its local SQLite behavior. It does not prove:
- deployed Backend endpoint identity or compatibility;
- Backend support for `Idempotency-Key`;
- Backend no-side-effects semantics for any HTTP error status;
- end-to-end exactly-once persistence;
- safe mixed-version deployment or concurrent migration under production load.

These items require separate runtime evidence and/or an independent review. Do not infer them from unit tests or green CI.
