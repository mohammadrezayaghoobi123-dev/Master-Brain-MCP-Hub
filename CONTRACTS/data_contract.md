# Data Contract — Memory Domain

> **REGEL:** Keine stillen Änderungen an Typen/Feldern.
> Vertragsänderungen benötigen eine explizite Projektfreigabe. Diese Revision wurde durch die ausdrückliche Projektowner-Anweisung vom 2026-11-28 autorisiert.

**Version:** 1.2.0  
**Letzte Änderung:** 2026-11-28  
**Scope:** Memory-Domain und lokale Dedup-Persistenz des MCP Hub. Dieser Vertrag beschreibt NICHT das SQLite-/Backend-Speicherschema des externen Brain-Dienstes.

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
| tags | string[] 1–10 | yes | lowercase preferred; entries must be non-empty strings |
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

The table above is the canonical field-level domain shape referenced by `CONTRACTS/api_contract.md`. It is a repository contract; conformance of a deployed external Backend remains a separate runtime verification requirement.

---

## Local dedup store (MCP Hub only)

The local deduplication database is not the Brain database. It coordinates Auto-Memory writes only among Hub processes that share the same SQLite file.

SQLite path selection:
- `DEDUP_DB_PATH`: explicit database-file path.
- `DATA_DIR`: database path is `$DATA_DIR/.data/auto-memory-dedup.sqlite`.
- Outside production, absent configuration falls back to `.data/auto-memory-dedup.sqlite` under the current working directory.
- In production, an explicit absolute `DEDUP_DB_PATH` or absolute `DATA_DIR` is mandatory. CWD-dependent paths are rejected.
- Production and `DEDUP_REQUIRE_SQLITE=1|true` fail closed if SQLite is unavailable. An in-memory fallback has no restart persistence and no cross-process coordination.

### Final SQLite schema

The constructor creates the base table and applies additive columns/indexes inside one `BEGIN IMMEDIATE` / `COMMIT` migration. Legacy rows receive `state='committed'` through the column default. On migration failure it attempts `ROLLBACK`, closes the native handle, and rethrows the original failure.

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

### Dedup state machine

```
free --claim--> pending --markUnknown--> unknown --commit--> committed
                    |                       |
                    | lease expires         | operator resolution:
                    v                       | not_stored -> delete row
                   free                     | stored -> committed
                                            |
                                            +-- never expires automatically
```

- `pending`: pre-dispatch reservation owned by one interaction. It is time-bounded by the effective lease. The same owner must successfully transition it to `unknown` before the external Brain POST is dispatched.
- `unknown`: the request may have been dispatched and its persistence outcome cannot be proven. It is quarantined, does not expire, is excluded from expiry purge, and blocks automatic retry. Its owner identity is retained for matching-owner transitions.
- `committed`: the Brain save has been positively confirmed by the Hub's response contract. The owner is cleared and the row is retained for the configured deduplication TTL.
- A `pending` row can expire before dispatch; it then becomes claimable. An `unknown` row never becomes claimable by elapsed time alone.
- `release` deletes only a matching owner's `pending` row. It cannot release `unknown` or `committed`.
- `revertUnknown` deletes only the matching owner's `unknown` row and is reserved for transport failures classified as definitely pre-dispatch. Timeouts, resets, HTTP errors, redirects, and malformed/unreadable success responses remain quarantined.
- `commit` changes only a matching owner's `unknown` row to `committed`. A stale owner cannot overwrite a successor claim.
- `add` may add a committed marker only when the key is free or an existing non-UNKNOWN row has expired. It cannot replace live `pending` or any `unknown` row.
- `status` is read-only: it returns `null` for an expired non-UNKNOWN row without performing a global purge write. `purgeExpired` removes expired non-UNKNOWN rows only.

### Operator reconciliation and audit

- Reconciliation is operator-only through the CLI; it is not exposed as an MCP tool.
- An operator identifies an UNKNOWN row using a unique hexadecimal hash prefix (8–64 characters). Multiple matches fail as ambiguous; the resolution also enforces a configured minimum age.
- `not_stored` deletes the matching UNKNOWN row, reopening the content for a future claim. `stored` converts it to `committed` for the selected TTL.
- The state change and corresponding `unknown_resolutions` insert occur in one `BEGIN IMMEDIATE` transaction. A failed transaction rolls back both.
- The audit row records timestamp, 12-character hash prefix, outcome, normalized operator, and optional normalized note. The implementation does not provide cryptographic tamper evidence, external anchoring, or protection against an actor with direct database write access. Those controls require a separate trusted system.
- Owner tokens and full content hashes are never included in safe operational summaries or CLI listing output.

This local store does **not** guarantee exactly-once writes to the external Brain Backend. Runtime Backend support for `Idempotency-Key`, endpoint identity, and durability must be verified independently.

---

## Changelog

| Datum | Änderung | Genehmigt von |
|-------|----------|---------------|
| 2026-11-08 | Defined real memory domain; added local dedup table | engineering |
| 2026-11-28 | Corrected local dedup schema, three-state lifecycle, owner rules, transactional operator resolution, and external-audit limitations | project owner (explicit authorization) |
