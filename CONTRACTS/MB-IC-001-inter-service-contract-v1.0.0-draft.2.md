# MB-IC-001 — Master Brain Inter-Service Contract
## OP-62 contract freeze candidate

- Contract ID: MB-IC-001
- Version: 1.0.0-draft.2
- Status: PROPOSED — NOT APPROVED — NOT IMPLEMENTED
- Prepared: 2026-11-12
- Scope: Master Brain MCP Hub ↔ Master Brain Backend
- Governing architecture: Central Core → Strategic Intelligence/Cognition → Domain Islands → AI Layer → Agents/Plugins/Tools
- Compatibility rule: additive migration; preserve existing data and legacy entry points until explicit deprecation approval.

> This document is a design artifact on an isolated branch. It does not authorize production activation, backend changes, merge, deployment, or secret rotation.

## 1. Purpose and invariants

Establish one versioned contract for memory writes and reads across Hub and Backend. The contract is part of the unified Master Brain super-project, not a replacement subsystem.

Normative invariants:

1. Fail closed: missing, invalid, expired, or unverifiable service identity is rejected. No implicit trust because a network is private.
2. Tenant and principal identity are derived from verified credentials and server-side membership, never trusted from request-body fields.
3. A logical memory write is idempotent across retries, Hub restarts, and multiple Hub instances.
4. A committed memory write and its required audit record are atomic in one database transaction.
5. A response timeout after a possible commit is UNKNOWN to the client. The client retries with the same idempotency key; it MUST NOT mint a new key for the same logical operation.
6. No external model/provider call occurs inside the database transaction.
7. Existing data, IDs, refs, and legacy type values are preserved during migration. No destructive rename or lossy type coercion.
8. Model confidence is metadata, not proof, authorization, or a substitute for independent evidence.
9. All state transitions and retries are traceable; no exactly-once network-delivery claim is made.
10. A compatibility adapter is not permission to weaken the target security contract.

## 2. Canonical API boundary

### 2.1 Canonical write

`POST /api/v2/memories`

Required headers:

- `Authorization: Bearer <short-lived service credential>`
- `Content-Type: application/json`
- `Idempotency-Key: "<UUID>"` (RFC 9651 Structured Field String syntax)
- `X-Request-ID: <opaque request identifier>` (optional client correlation; server may generate one)

The idempotency key is a random UUID (UUIDv4 or UUIDv7). The server validates syntax and length before lookup. It is not an authorization credential and must not appear in URLs or ordinary logs.

### 2.2 Canonical request

```json
{
  "schema_version": "2.0",
  "event_id": "producer-scoped-stable-event-id",
  "type": "decision",
  "content": "Required non-empty string",
  "summary": "Optional concise summary",
  "tags": ["optional", "normalized"],
  "refs": ["optional legacy-compatible references"],
  "source": {
    "tool": "codex",
    "session_id": "optional",
    "project": "optional",
    "file": "optional"
  },
  "metadata": {},
  "provenance": {
    "origin": "agent-or-human-asserted-source",
    "evidence_refs": []
  },
  "classification": "internal",
  "consent_ref": null
}
```

Server-derived fields MUST NOT be accepted as authoritative body input: `tenant_id`, `principal_id`, `owner_id`, authenticated `user_id`, authorization scopes, audit actor, or credential claims. If present in a request, reject them or ignore only under a documented compatibility adapter; never trust them.

The `source` object is descriptive provenance supplied by the caller, not authenticated identity. The server records verified `producer_id` and `principal_id` separately.

### 2.3 Canonical response

Successful first write: HTTP 201.

```json
{
  "data": {
    "id": "UUID",
    "legacy_id": null,
    "schema_version": "2.0",
    "tenant_id": "server-derived",
    "type": "decision",
    "content": "...",
    "summary": null,
    "tags": [],
    "refs": [],
    "source": {},
    "metadata": {},
    "provenance": {},
    "classification": "internal",
    "consent_ref": null,
    "event_id": "...",
    "created_at": "RFC3339 timestamp",
    "updated_at": "RFC3339 timestamp"
  },
  "request_id": "...",
  "idempotency": {
    "status": "COMMITTED",
    "replayed": false
  }
}
```

A retry after commit with the same key and identical semantic payload MUST replay the stored status and response body, with `replayed: true` permitted as transport metadata. The underlying memory identity and effects remain unchanged.

## 3. Identity and authorization

### 3.1 Target identity model

- Each Hub installation/workload authenticates as a service principal.
- The backend validates issuer, audience, signature, expiry, not-before, and permitted algorithm; it resolves principal, tenant membership, and scopes server-side.
- Prefer short-lived workload identity (OIDC client credentials or mTLS-backed identity) with rotation and revocation. Selection of the concrete issuer/credential mechanism is an infrastructure ADR and remains OPEN until deployment constraints are verified.
- A static shared API token is legacy-only. If temporarily supported, it requires an explicit compatibility feature flag, must be disabled by default, scoped to one service and tenant, and have an expiry/removal plan. It is not the target IAM architecture.
- Cloudflare Access/network perimeter may add defense in depth but is not the authoritative application identity or tenant authorization layer.

### 3.2 Authorization scopes

Minimum scopes:

- `memory:write`
- `memory:read`
- `memory:search`
- `memory:delete` (separate and narrowly granted)
- `audit:read`
- `admin:policy`

Unauthenticated/unverifiable/expired credential → 401.
Authenticated but inactive principal, tenant mismatch, or missing scope → 403.
Authorization provider unavailable or identity cannot be verified → fail closed (503 where dependency unavailable; never silently allow).

## 4. Idempotency semantics

### 4.1 Separate identifiers

- `event_id`: identifies a logical producer event and is stable across all transports/retries.
- `Idempotency-Key`: identifies one API operation attempt family and is stable across retries of that operation.
- They are distinct concepts and MUST NOT be conflated. A producer may derive them from the same source event only if the mapping is explicitly deterministic and documented; storage and uniqueness scopes remain separate.

### 4.2 Uniqueness scopes

- Request key: UNIQUE (`tenant_id`, `principal_id`, `operation`, `idempotency_key`).
- Logical event: UNIQUE (`tenant_id`, `producer_id`, `event_id`).
- Fingerprint: server-generated SHA-256 over canonicalized semantic request fields after validation. Exclude transport-only headers, request IDs, credentials, and server-generated timestamps. Include schema version, event ID, type, content, summary, tags, refs, source claims, metadata, provenance, classification, and consent reference.

The backend is authoritative. Hub-local SQLite/Map deduplication may reduce duplicate analysis work but MUST NOT be described as durable system-wide idempotency.

### 4.3 Required behavior

| Condition | HTTP | Required behavior |
|---|---:|---|
| Missing/invalid Idempotency-Key | 400 | Reject before write |
| First valid request | 201 | Commit memory + audit + idempotency result atomically |
| Same key, same fingerprint, prior commit | original status | Replay original response; no second memory |
| Same key, different fingerprint | 422 | Reject; preserve original result |
| Same key while first transaction is outstanding | 409 or bounded wait then replay | No second write; include retry guidance |
| Same event_id under another key | 409 or deterministic existing-event response | Never create second logical event |
| Auth missing/invalid/expired | 401 | No data access |
| Authenticated but unauthorized | 403 | No data access |
| DB/identity dependency unavailable | 503 | Fail closed; client treats write outcome as UNKNOWN if commit may have occurred |

The 409 response is retryable with the SAME key after the outstanding operation resolves. A 422 is not retryable with that key; the client must correct the payload and create a new operation only if it is genuinely a new logical operation.

### 4.4 Client state machine

`NEW → SUBMITTED → COMMITTED`

On transport timeout or connection loss after submission:
`SUBMITTED → UNKNOWN`

From UNKNOWN, retry the identical request with the identical key:
- backend finds committed result → replay and move to COMMITTED;
- backend finds no committed result → safely process once;
- request still outstanding → 409/bounded wait, remain UNKNOWN/RETRYABLE;
- key/payload mismatch → 422, enter terminal protocol error.

The client MUST NOT release a key merely because a network request timed out. The client MUST NOT generate a replacement key while the original outcome is UNKNOWN.

## 5. Transaction and persistence boundary

Before opening the transaction: authenticate, authorize, validate schema, normalize/canonicalize request, compute fingerprint. No model/provider call in transaction.

One PostgreSQL transaction:

1. Insert idempotency key/fingerprint under the unique scope.
2. Resolve uniqueness conflict deterministically; compare fingerprint.
3. Insert canonical memory record (including server-derived tenant/principal/producer).
4. Insert immutable audit event for the write.
5. Store replayable HTTP status/body and memory ID in idempotency record.
6. If a real downstream event must be published, insert outbox event in the same transaction.
7. Commit once; only then return success.

Required database constraints are the final concurrency authority. Application-level check-then-insert and process-local Maps are insufficient.

A short transaction is preferred. Do not hold a database transaction open while calling AI providers, external APIs, or waiting on human review.

### Outbox decision

Outbox is REQUIRED only for a real cross-module/external side effect that must reliably follow the memory commit. If no such side effect exists in this increment, do not add an unused queue/table merely for architecture aesthetics. If required, insert outbox row in the same transaction and make consumers idempotent. Do not claim exactly-once delivery; provide at-least-once delivery with deduplicated effects.

## 6. Canonical memory schema and legacy compatibility

### 6.1 Canonical fields

Canonical Memory v2 retains the OP-33 fields:

- `schema_version`, UUID `id`, optional `legacy_id`
- server-derived `tenant_id`, `owner_id`/principal relationship
- `type`, `content`, `summary`, `tags`, `refs`
- `source`, `metadata`, `provenance`
- `classification`, `consent_ref`, `event_id`
- `created_at`, `updated_at`

Audit and idempotency are separate first-class records; they are not free-form metadata.

### 6.2 Type compatibility

Current Hub types: `decision, fix, learning, pattern, preference, config, error, context, conversation`.
Current Backend types: `policy, decision, learning, code, error, fix, note, task`.

Until a domain-approved taxonomy migration exists, canonical v2 accepts the union without lossy coercion:
`decision, fix, learning, pattern, preference, config, error, context, conversation, policy, code, note, task`.

Do not silently map `policy` to `config`, `code` to `fix`, or `task` to another type. Preserve original legacy type and source ID during backfill. Any later consolidation requires a separately reviewed, reversible mapping ADR and data migration.

### 6.3 Legacy endpoints

Existing Hub path `/api/brain/entries` and Backend path `/memory/append` are not equivalent today. Do not claim they are compatible.

Migration plan:
- Add canonical v2 endpoint and contract tests first.
- Add explicit adapters for each legacy route; adapters translate request/response only and call the same canonical service/transaction.
- Preserve existing routes during a defined migration window.
- Instrument adapter usage and error rates.
- Deprecate only after all callers are inventoried, migrated, and verified.
- No destructive rename or removal in this contract increment.

## 7. Error model

Use RFC 9457 Problem Details-compatible error bodies with stable machine codes. Do not leak SQL errors, secrets, stack traces, raw tokens, or internal hostnames.

Required codes include:
`AUTHENTICATION_REQUIRED`, `AUTHENTICATION_INVALID`, `AUTHORIZATION_DENIED`, `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `REQUEST_IN_PROGRESS`, `EVENT_ALREADY_EXISTS`, `TENANT_CONTEXT_REQUIRED`, `DEPENDENCY_UNAVAILABLE`, `OUTCOME_UNKNOWN`, `INTERNAL_ERROR`.

## 8. Retention, deletion, and privacy

Retention is NOT frozen in this draft. Production approval is blocked until the owner decides:
- idempotency record retention and expiry;
- event identity/tombstone retention after memory deletion;
- audit retention and access policy;
- consent withdrawal and deletion behavior;
- legal hold and backup expiry behavior.

Do not purge idempotency state while a retry could recreate a deleted or previously committed memory. Deletion must not permit accidental resurrection from an old retry. A minimal non-content tombstone/digest may be needed, subject to privacy/legal review.

## 9. Migration sequence

1. Freeze this contract and resolve OPEN decisions.
2. Implement OpenAPI 3.1 + JSON Schemas + shared contract tests in Hub repo.
3. Obtain backend owner approval and implement additive PostgreSQL migrations, indexes, constraints, canonical write service, auth middleware, and adapters in Backend repo.
4. Implement Hub client key persistence and UNKNOWN/RETRYABLE/COMMITTED state handling; remove silent in-memory fallback from any production-critical guarantee.
5. Run integration, concurrency, crash/recovery, tenant isolation, authorization, compatibility, and migration tests against a disposable PostgreSQL environment.
6. Independent reviewer validates final exact SHAs and test evidence.
7. Stage rollout with feature flag and observability; rollback plan must preserve committed data and idempotency records.
8. Production release only after separate release authorization.

## 10. Acceptance tests

- T01: first request commits exactly one memory and one audit row.
- T02: retry after committed write/lost response replays same memory ID.
- T03: concurrent same-key/same-payload requests produce one logical write.
- T04: same key/different payload returns 422 and preserves original response.
- T05: same event under a different key cannot create a duplicate logical event.
- T06: crash before transaction commit leaves no partial memory/audit/idempotency effects.
- T07: crash after commit before HTTP response is recoverable by same-key retry.
- T08: missing, invalid, expired, wrong-audience credentials are rejected.
- T09: valid principal without required scope is rejected.
- T10: cross-tenant read/write leakage is impossible under RLS and server-derived tenant context.
- T11: DB outage or unavailable idempotency store never falls back to Map and never reports success.
- T12: two or more Hub instances share backend idempotency guarantees.
- T13: legacy IDs, refs, type values, and data survive additive migration.
- T14: outbox (if enabled) replays safely and consumer effects are deduplicated.
- T15: deletion followed by an old retry cannot resurrect deleted data.
- T16: audit records actor, tenant, operation, target, request ID, and outcome without storing credentials or unnecessary sensitive content.

## 11. Open decisions — production blockers

- O1: concrete service identity mechanism and issuer/rotation/revocation model.
- O2: retention, deletion tombstone, audit, and backup expiry policy.
- O3: whether an outbox consumer is required in the first increment.
- O4: exact legacy compatibility window and adapter ownership.
- O5: whether producer-scoped event uniqueness should be tenant-wide or additionally domain-scoped.
- O6: owner and write authority for Backend repository `Activi-AI/Master_Brain`.

## 12. OP-62 disposition

This draft resolves the contract-level contradictions found in OP-61, but it is not an implementation or production approval.

Current status:
- Contract draft: PRESENT on isolated Hub branch.
- Hub code changes: NONE.
- Backend code/schema changes: NONE.
- Tests executed by this operation: NONE.
- Independent review: PENDING.
- Production authorization: BLOCKED pending O1–O6 and verification.

