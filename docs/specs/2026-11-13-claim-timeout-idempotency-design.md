# Claim, Timeout, and Idempotency Protocol Design

- Date: 2026-11-13
- Repository: `mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub`
- Design base: `fea31f01b6b56e498a0f6a1f1c340c05ea8ca186` (PR #5 head observed during preparation)
- Related work: PR #5 and PR #8; policy applies to all dependent and future PRs
- Status: **Design approved by project owner; implementation not yet authorized by this document**
- Safety: no merge, deployment, destructive branch operation, or Runtime mutation is included

## 1. Purpose and non-goals

Define a verifiable protocol for Auto-Memory claim ownership, bounded execution time, timeout handling, deduplication, ambiguous outcomes, and Runtime idempotency. Preserve the existing PR #5 SQLite constructor cleanup and deterministic two-process barrier test, and selectively retain valid PR #8 timeout/TTL improvements without importing its weaker race test.

This design does not claim exactly-once delivery or exactly-once persistence. Those claims remain prohibited until the Runtime contract and end-to-end recovery behavior are implemented and independently verified.

## 2. Normative terms and status vocabulary

The words MUST, MUST NOT, SHOULD, and MAY are normative requirements.

Required evidence states:

- `PASS`: the exact stated property was exercised by an appropriate test or independently verifiable evidence.
- `FAIL`: evidence demonstrates the property is violated.
- `UNVERIFIED`: evidence is absent, incomplete, stale, or does not test the stated property.
- `UNKNOWN`: a particular write may have reached the Runtime, but its durable outcome is not yet known. This is a runtime operation state, not a test result.

A green CI run, a mergeable PR, a successful HTTP response from an unsupported endpoint, or the presence of an `Idempotency-Key` header MUST NOT by itself establish Runtime idempotency.

## 3. Hard time budget

The maximum effective claim lifetime is exactly:

`MAX_EFFECTIVE_LEASE_MS = 86_400_000` (24 hours).

The configured claim lease MUST be finite, positive, and no greater than this maximum. Supplied invalid values (including NaN, positive/negative Infinity, zero, negative values, malformed numeric environment values, and values beyond the documented bound) MUST be rejected with `RangeError`; invalid input MUST NOT silently fall back or be silently clamped. An omitted setting MAY use a documented default.

Define explicit, non-overlapping budgets:

- `T_analysis`: maximum analysis duration.
- `T_backend`: maximum Runtime request duration.
- `T_finalize`: maximum local durable finalization duration.
- `T_margin`: explicit safety margin for scheduling/clock/cleanup uncertainty.

The protocol MUST validate:

`T_analysis + T_backend + T_finalize + T_margin <= MAX_EFFECTIVE_LEASE_MS`.

All values MUST be finite positive integers in milliseconds, except a margin may be zero only if the implementation provides a documented reason and tests. Unit conversion MUST be checked for overflow and precision loss.

The effective lease is derived deterministically as:

`effectiveLease = max(configuredLease, T_analysis + T_backend + T_finalize + T_margin)`.

The derived value MUST be <= 24 hours. If the aggregate execution budget exceeds 24 hours, reject configuration with `RangeError`. A configured lease shorter than the validated execution floor is not silently accepted as the actual lease: the effective lease is explicitly derived upward to that floor and the derived value is exposed in safe diagnostics. A configured lease greater than 24 hours is rejected.

No timeout may be enlarged after a claim has been acquired unless the remaining claim budget is revalidated atomically and still satisfies the hard cap. The initial implementation SHOULD make the operation budget immutable for the lifetime of one interaction.

## 4. Deadline and cancellation semantics

Each stage MUST receive an absolute deadline derived from a monotonic clock. Elapsed-time calculations inside a process MUST NOT depend on wall-clock adjustments.

- The analysis client MUST receive a bounded timeout and cancellation signal.
- The Brain/Runtime client MUST receive a bounded timeout and cancellation signal.
- Cancellation MUST be propagated to the actual underlying operation where supported; merely racing a promise against a timer is insufficient.
- A timeout means the caller stopped waiting or cancellation was requested. It MUST NOT be interpreted as proof that the remote side effect did not occur.
- After cancellation, the Hub MUST prevent a late local completion from committing stale claim state.
- Runtime-side transactional idempotency remains necessary because a request may already have been received or committed before cancellation took effect.

Tests MUST demonstrate cancellation propagation and late-completion behavior using controllable deferred operations. If a dependency cannot guarantee cancellation, the operation outcome MUST be treated as ambiguous.

## 5. Claim ownership, fencing, and storage semantics

The DedupStore contract MUST define ownership consistently for Memory and SQLite implementations. SQLite is the authoritative backend for cross-process contention; in-memory behavior MUST NOT be represented as cross-process safe.

Required invariants:

1. At most one current pending owner exists for a deduplication key.
2. Claim acquisition is atomic.
3. Commit and release require the current owner token and current generation.
4. An expired or superseded owner cannot commit or release a newer owner's claim.
5. The owner check and state transition occur in one SQLite transaction.
6. A stale worker cannot overwrite a newer generation.
7. Purge/expiry cannot erase evidence needed to reconcile an ambiguous write prematurely.

A monotonically increasing fencing generation SHOULD be persisted per logical key. A random owner token remains useful as an unguessable capability but is not, by itself, an ordered fencing token.

Important boundary: Hub-side fencing protects Hub state transitions. It cannot revoke a request already accepted by an external Runtime. To fence external side effects, Runtime must validate an idempotency identity or fencing generation inside its own transaction. Until that exists, external exactly-once behavior is UNVERIFIED.

## 6. State machine and ambiguous outcomes

Required logical states:

- `AVAILABLE`: no active claim blocks a new attempt.
- `PENDING`: a current owner is executing before a write may have been dispatched.
- `UNKNOWN`: the write may have reached Runtime; durable outcome is unresolved.
- `COMMITTED`: durable save is confirmed and associated with the idempotency identity.
- `EXPIRED`: lease elapsed; this alone does not prove that a previously dispatched write failed.

Permitted transitions MUST be explicit and tested:

- `AVAILABLE -> PENDING`: atomic claim acquisition.
- `PENDING -> AVAILABLE`: safe release before any write could have been dispatched.
- `PENDING -> UNKNOWN`: timeout, connection loss, process interruption, or other ambiguous outcome after dispatch may have begun.
- `PENDING -> COMMITTED`: Runtime success is confirmed and local commit succeeds.
- `UNKNOWN -> COMMITTED`: reconciliation confirms the original write.
- `UNKNOWN -> PENDING`: retry is permitted only when the same stable idempotency identity is reused and Runtime guarantees deduplication.
- `EXPIRED -> AVAILABLE`: only after the recovery policy has considered any associated UNKNOWN outcome; expiry is not proof of non-persistence.

An HTTP error status MUST NOT be assumed to mean no write occurred unless the Runtime contract explicitly guarantees that property for that response and the guarantee is tested.

## 7. Runtime idempotency contract

Runtime idempotency is a separate, required integration workstream. The Hub header alone is not evidence of support.

Runtime MUST provide:

1. A stable idempotency identity for one logical write, scoped by authenticated tenant/owner and operation.
2. A canonical request fingerprint bound to that identity.
3. Atomic persistence of idempotency record and business data in one database transaction.
4. Same key + same fingerprint: return the original durable outcome without creating another record.
5. Same key + different fingerprint: reject with a deterministic conflict response.
6. Concurrent same-key requests: serialize/resolve atomically; no check-then-insert race.
7. Durable replay/reconciliation after Runtime restart.
8. A documented retention period that exceeds the maximum retry and recovery horizon; key cleanup MUST NOT reopen a duplicate-write window.
9. Safe handling of authentication, tenant boundaries, and key secrecy.
10. A documented response contract that allows the Hub to distinguish confirmed success, confirmed rejection, and unresolved outcome.

The Runtime endpoint and schema currently MUST be treated as unverified until inspected and tested. The Hub must not claim this contract is implemented merely because it sends an `Idempotency-Key` header.

## 8. Clock and persistence rules

- Use a monotonic clock for in-process elapsed time and deadlines.
- Persist UTC epoch timestamps for durable expiry/recovery metadata.
- Do not use local timezone values for expiry calculations.
- Document how restart, clock rollback/forward, and host clock skew affect expiry.
- Where multiple hosts participate, wall-clock expiry alone is insufficient for strong ownership; transactional fencing/idempotency is authoritative.
- Use safe integer validation for millisecond values and checked conversion between milliseconds and minutes.

## 9. Configuration and compatibility

All validation MUST run at both construction and `updateConfig` boundaries. Environment values MUST be parsed strictly; missing values may use defaults, but malformed supplied values MUST fail closed.

The same validation function and invariants SHOULD be shared across constructor, update, and client construction. No mutation of the caller's config object is permitted; validate a copy, then atomically replace the effective configuration only after all checks pass.

A failed `updateConfig` MUST leave the previous valid configuration unchanged.

The PR MUST document compatibility impact for existing callers and environment variables. If a compatibility mode is needed, it must be explicit, observable, temporary, and separately tested; silent normalization is prohibited.

## 10. SQLite migration and transaction safety

Any schema change for generation, UNKNOWN state, idempotency metadata, or recovery MUST be additive and migration-safe.

- Migrations MUST be idempotent.
- Constructor failure MUST close the native database handle while preserving the original error.
- Multi-statement state transitions MUST use explicit transactions.
- Unique constraints/indexes MUST enforce the intended uniqueness at the database layer.
- Migration tests MUST cover fresh databases, legacy databases, partially applied migration, and restart.
- Existing data MUST not be discarded or reinterpreted as a confirmed state without evidence.

The existing PR #5 constructor-cleanup behavior and deterministic two-process barrier race test MUST be preserved or replaced only by a demonstrably stronger test.

## 11. Required test matrix

### Unit and boundary tests

- NaN, infinities, zero, negative, malformed string, unsafe integer, overflow, and >24-hour values.
- Millisecond/minute conversion boundaries.
- Aggregate operation budget exactly at the cap and one unit above it.
- Configured lease below the derived floor, equal to it, and above it.
- Constructor and updateConfig equivalence.
- Failed update leaves previous config unchanged.
- Stage deadline propagation and abort behavior.
- Late completion cannot commit after owner supersession.
- Same owner versus wrong owner commit/release.
- TTL and purge boundaries.

### SQLite integration and concurrency tests

- Two independent child processes wait at a barrier; only one acquires the same key.
- Verify state using a third independent connection.
- Concurrent commit/release and expiry races.
- Restart while PENDING and UNKNOWN.
- Migration from legacy schema and interrupted migration recovery.
- No early purge of UNKNOWN/reconciliation records.

### Runtime contract tests

- Same key/same payload sequential replay.
- Same key/same payload concurrent replay.
- Same key/different payload conflict.
- Runtime restart followed by replay.
- Commit followed by lost response and retry.
- Transaction rollback at each failure point.
- Tenant isolation.
- Retention/expiry boundary.

### CI and evidence

Run typecheck, lint (if configured), full unit tests, build, npm audit, and the supported Node matrix (22/24/26) on the exact final SHA. Record commands, exit codes, workflow run IDs, commit SHA, runtime/database version, and relevant test output. A previous green run on another SHA is not evidence for the current SHA.

## 12. PR integration policy

All PRs MUST state:

- exact base branch and base SHA;
- exact head SHA;
- dependency PRs and dependency order;
- files/contracts changed;
- invariants preserved;
- test evidence and exact commands;
- remaining risks and UNVERIFIED claims;
- rollback and compatibility notes.

A PR is not integration-ready merely because GitHub reports it mergeable or CI is green. No PR may weaken an existing deterministic test, remove a prior invariant, or declare a dependent capability PASS without its own evidence.

PR #5 and PR #8 MUST be reconciled on a new isolated branch. Existing branches remain untouched. Retain the PR #5 barrier-based SQLite test and constructor cleanup. Selectively carry forward valid PR #8 upper-bound/TTL tests and implementation, then add this protocol's required tests. Resolve the configured-vs-effective lease semantics exactly as specified here.

## 13. Acceptance gates

- **Gate A — Hub correctness:** configuration validation, bounded deadlines, cancellation semantics, ownership, fencing within Hub, TTL, SQLite concurrency, and recovery state behavior pass.
- **Gate B — Runtime idempotency:** all Runtime idempotency contract tests pass against the actual Runtime implementation and database.
- **Gate C — End-to-end assurance:** ambiguous timeout, lost response, process restart, concurrent retry, and stale worker scenarios are verified across Hub and Runtime.

Until Gate B and Gate C pass, exactly-once persistence and end-to-end exactly-once guarantees MUST remain `UNVERIFIED`. Hub-local deduplication MUST NOT be marketed as a substitute.

## 14. Implementation sequence and safety boundaries

1. Reconfirm current PR #5/#8 heads and branch ancestry before edits.
2. Inspect current Hub interfaces, SQLite schema, API contract, Runtime endpoint, and actual Runtime database capabilities.
3. Produce an implementation plan with file-level changes and dependency gates.
4. Add failing tests first (TDD Red); record exact failing output.
5. Implement the smallest compatible change (Green), then refactor.
6. Run targeted tests, full suite, build, audit, and Node matrix on exact SHA.
7. Compare the corrective branch with PR #5 and PR #8 to prove no required behavior was lost.
8. Request independent Claude review in read-only mode; reviewer must inspect code and evidence, not modify branches.
9. Stop before merge/deploy. Those actions require separate explicit authorization.

No implementation, Runtime mutation, merge, deployment, or deletion is authorized by this design document.
