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

Define explicit bounded budgets for every execution stage, retry, wait, and durable finalization step. Stage budgets MUST be finite positive safe integers in milliseconds; a zero safety margin requires a documented justification and dedicated tests. The operation budget MUST be derived from the actual dependency graph's critical path as specified in Section 15.2, not from an assumed serial or parallel relationship. Unit conversion MUST be checked for overflow and precision loss.

The effective lease is derived deterministically as:

`effectiveLease = max(configuredLease, T_execution_floor)`,

where `T_execution_floor` is defined in Section 15.2.

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

A monotonically increasing fencing generation MUST be persisted per logical key whenever the generation is used to fence work across process or service boundaries. The generation MUST NOT reset while an older worker or delayed request could still exist; purging a claim row MUST NOT silently reset its generation. A random owner token MUST also be used as an unguessable capability and compared on every state transition. If the implementation cannot guarantee a durable monotonic generation, it MUST use a non-reusable claim identity for Hub-local compare-and-swap and MUST NOT claim downstream fencing.

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
- `PENDING -> AVAILABLE`: safe release only when the implementation can prove that no write was dispatched and no side effect can still be in flight.
- `PENDING -> UNKNOWN`: timeout, connection loss, process interruption, or other ambiguous outcome after dispatch may have begun.
- `PENDING -> COMMITTED`: Runtime success is confirmed and local commit succeeds under current owner/generation.
- `UNKNOWN -> COMMITTED`: reconciliation confirms the original write.
- `UNKNOWN -> PENDING`: retry is permitted only with the same stable idempotency identity and only after Runtime's atomic deduplication contract is verified.
- Expired `PENDING` with no possible dispatch MAY return to `AVAILABLE`; expired `PENDING` after possible dispatch MUST enter or remain `UNKNOWN` until reconciliation. `EXPIRED` is an expiry condition, not evidence of non-persistence.

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


## 15. Precision amendments: assumptions, time semantics, and concurrency proof

This section resolves implementation-critical ambiguities in the preceding requirements. If any earlier wording conflicts with this section, this section governs.

### 15.1 The 24-hour guarantee and clock trust model

A strict elapsed-real-time upper bound cannot be proven from a wall clock that may move backward, nor can a process-local monotonic clock survive a process restart as a durable timestamp. Therefore the 24-hour rule is defined as a hard protocol bound under an explicit trusted-time assumption:

- During one process lifetime, deadline arithmetic MUST use a monotonic clock.
- Durable acquisition and expiry instants MUST be stored in UTC using one authoritative clock source.
- For a single-host SQLite deployment, the host clock is the authority. A detected backward clock jump or implausible clock discontinuity MUST fail closed: no new claim takeover or retry that could create a duplicate write is allowed until time consistency is re-established.
- For a multi-host deployment, the shared database/server clock MUST be authoritative for durable lease decisions; application-host clocks MUST NOT independently decide ownership.
- The implementation MUST record acquisition time, expiry time, and the time-source identity/version needed for diagnosis.
- Recovery after restart MUST conservatively treat an uncertain time interval as unresolved; it MUST NOT shorten an UNKNOWN recovery obligation merely because the local clock changed.
- The system MUST state this assumption in operational documentation. It MUST NOT claim a mathematically unconditional real-world 24-hour bound in an environment with an untrusted or discontinuous clock.

### 15.2 Correct budget arithmetic for sequential and parallel stages

The aggregate budget MUST be computed from the actual execution dependency graph, not by blindly summing all configured timeouts or taking their maximum.

For sequential stages, the critical-path budget is their sum. For genuinely parallel stages, the relevant duration is the longest bounded path through the execution graph, including synchronization and finalization. Retries MUST be included in the total operation budget; unbounded retry loops are prohibited.

Define:

- `T_critical_path`: maximum bounded duration of the operation's dependency graph, including all allowed retries and waits.
- `T_finalize`: maximum durable local state-transition duration not already included in the critical path.
- `T_margin`: explicit bounded safety allowance.

The validated execution floor is:

`T_execution_floor = T_critical_path + T_finalize + T_margin`.

The effective lease is:

`effectiveLease = max(configuredLease, T_execution_floor)`.

Configuration MUST be rejected if any stage/retry is unbounded, if arithmetic overflows a safe integer, or if `T_execution_floor > 86_400_000 ms`. No retry may reset the original operation deadline or extend the original claim's 24-hour maximum.

### 15.3 Ownership linearization points

The implementation MUST document the linearization point for each operation:

- Claim acquisition: the successful atomic insert/conditional update protected by the unique key constraint.
- Commit: the transaction that verifies current owner token, generation, unexpired lease, and expected state, then writes COMMITTED.
- Release: the transaction that verifies current owner token, generation, and releasable state, then releases the claim.
- Expiry takeover: the transaction that verifies expiry using the authoritative time source and checks the prior operation's dispatch/reconciliation state before assigning a new owner.

Each operation MUST be a compare-and-swap against expected prior state. A read followed by an unguarded write is not sufficient. Tests MUST exercise the competing interleavings around these linearization points.

### 15.4 Claim identity, generation retention, and ABA prevention

A claim MUST have a unique owner identity. Where monotonic fencing is required, its generation MUST be strictly increasing for the lifetime of the logical deduplication key. Deleting an expired row and recreating it with generation 1 can create an ABA-style ownership ambiguity and is prohibited if stale work may remain.

Generation retention MUST therefore be handled by one of:

1. a durable per-key generation/tombstone record retained beyond the maximum stale-worker and delayed-request horizon; or
2. a globally monotonic generation allocator whose uniqueness and durability are enforced transactionally.

The chosen approach MUST be justified against the actual database and deployment topology. A random UUID can prevent accidental identity reuse but does not provide ordered fencing to an external service.

### 15.5 Expiry, UNKNOWN, and safe takeover

Lease expiry only says the lease deadline has elapsed according to the authoritative clock. It does not prove that the worker stopped or that a dispatched write failed.

A new owner MUST NOT take over an expired claim associated with a possibly dispatched write unless one of the following is true:

- Runtime reconciliation confirms that the prior write did not commit and cannot later commit; or
- Runtime idempotency guarantees that the retry uses the same stable key and cannot create a second logical write.

If neither condition is established, the key remains blocked in UNKNOWN/reconciliation state. This is a deliberate availability trade-off in favor of duplicate-write safety. The implementation MUST expose this blocked state and its age through safe operational telemetry.

### 15.6 Idempotency identity and canonical request fingerprint

The Runtime contract MUST define canonicalization precisely. The fingerprint MUST cover every field that changes the logical side effect, including operation type, tenant/owner scope, target resource, and normalized payload. It MUST exclude transport-only fields that do not change the operation semantics.

Canonicalization MUST be versioned. A key reused with a different canonicalization version or a different fingerprint MUST produce a deterministic conflict or an explicitly specified migration behavior; it MUST NOT silently map to an unrelated prior result.

The Runtime database MUST enforce uniqueness on the scoped idempotency identity. The idempotency record and business write MUST commit or roll back in the same transaction. A transactionally stored result/status MUST be sufficient to answer replay after process restart.

Key retention MUST cover the maximum period during which any client, queue, operator, backup replay, or recovery process could resend the logical operation. If that horizon is unbounded, the system MUST retain a compact tombstone or equivalent deduplication identity indefinitely; deleting the only deduplication evidence is prohibited.

### 15.7 Fault-injection and model-based verification

Beyond ordinary unit tests, the implementation SHOULD include deterministic fault-injection tests at each boundary:

- before dispatch;
- after dispatch but before Runtime commit;
- after Runtime commit but before response;
- after response but before Hub commit;
- during Hub commit;
- during process termination/restart;
- during expiry takeover and concurrent retry.

For each injected fault, assert the invariant: no stale owner can mutate current Hub state, and no ambiguous retry can create a second logical Runtime write.

A small state-transition/property-based test SHOULD generate legal and adversarial interleavings for claim, commit, release, expiry, restart, and retry. The test oracle MUST assert invariants, not merely expected example outputs. Seeds and failing traces MUST be retained for reproducibility.

### 15.8 Observability and operational controls

Structured telemetry MUST include operation correlation ID, hashed/scoped deduplication identity, owner generation, state transition, deadline/expiry, time-source identity, retry count, and outcome classification. It MUST NOT include raw idempotency keys, owner capabilities, credentials, or sensitive payloads.

At minimum, operators MUST be able to detect:

- UNKNOWN claims and their age;
- claims nearing expiry;
- stale-owner commit/release attempts;
- clock discontinuity/fail-closed events;
- idempotency conflicts;
- reconciliation failures and backlog;
- repeated retry exhaustion.

Alerts and runbooks MUST define safe operator actions. Manual deletion of UNKNOWN claims MUST NOT be the default recovery procedure.

### 15.9 Required design assumptions to verify before implementation

The implementation-planning phase MUST verify, rather than assume:

- whether the current SQLite library and transaction usage support the required atomic compare-and-swap semantics;
- whether the current schema can preserve generation/tombstone state safely;
- whether the Hub has a real cancellation path through every network/client layer;
- whether Runtime writes are transactional and which database uniqueness constraints exist;
- whether Runtime can expose a reconciliation/read-by-idempotency operation;
- whether the deployment is single-host or multi-host and what clock is authoritative;
- whether current callers depend on silent timeout/TTL normalization.

Any unanswered item MUST remain an explicit implementation blocker or UNVERIFIED dependency, not be filled by assumption.


## 16. Repository evidence and implementation boundary (2026-11-13)

The following facts were verified against repository source, not inferred from the design:

### 16.1 Hub baseline evidence (PR #5 head, before this corrective branch)

- The PR #5 baseline used `DedupState = 'pending' | 'committed'` and had no durable `unknown` state.
- `processInteraction` retained an ambiguous reservation as `pending`; ordinary expiry/purge could remove it.
- The baseline ambiguous-outcome test explicitly demonstrated that a simulated backend write followed by a lost response was retried after lease expiry, producing two backend write attempts.
- The baseline `commit` path could UPSERT a confirmed stale save over a successor's pending row, conflating durable outcome with current claim ownership.
- The baseline `effectiveLeaseMinutes` had no 24-hour effective cap, and selected timeout paths silently substituted defaults for invalid values.

These are baseline facts. The corrective branch implementation is recorded in Section 17 and the verification report.

### 16.2 Runtime repository evidence and unresolved deployment identity

The accessible repository `Activi-AI/The-Brain` currently exposes `POST /api/memory/store`. Its `src/tools.ts` implementation inserts directly into `memories`; the inspected schema has no idempotency table or unique idempotency constraint, and the inspected handler does not consume `Idempotency-Key`. Its package test script is a placeholder that exits successfully without running tests.

The Hub client currently targets `/api/brain/entries`. The available evidence does not establish that `Activi-AI/The-Brain` is the code deployed behind the Hub's configured `BRAIN_API_URL`, nor that the production endpoint is identical to either repository contract. Therefore:
- The-Brain is a verified candidate Runtime implementation, not yet proven to be the deployed target.
- Hub-to-Runtime endpoint compatibility is `UNVERIFIED`.
- Runtime idempotency is `UNVERIFIED` for the deployed service and `NOT IMPLEMENTED IN THE INSPECTED THE-BRAIN SOURCE`.
- No end-to-end exactly-once claim is permitted.

The connected GitHub identity has read access but no push permission to `Activi-AI/The-Brain`; no Runtime code has been modified.

### 16.3 Hub safety behavior implemented on the corrective branch

The isolated Hub branch implements the fail-closed containment behavior:
- Before dispatch, the owner transitions its durable row from `pending` to `unknown` using an owner-checked compare-and-set.
- If that transition cannot be durably confirmed, the Hub does not dispatch the write.
- `unknown` is not expired or purged automatically and blocks a new attempt for the same logical key.
- Only the same owner may commit the `unknown` row after a contract-valid BrainEntry response.
- A timeout, transport failure, malformed success response, process restart, or ambiguous HTTP error leaves the row `unknown`.
- Store `add` and `release` cannot resolve or remove `unknown`; a stale owner cannot overwrite a successor.
- SQLite persists `unknown_since`; safe diagnostics expose only UNKNOWN count and oldest timestamp.
- Time configuration and store-level durations are validated strictly; effective claim lease is capped at 86,400,000 ms.

An `unknown` row still requires an explicit reconciliation procedure backed by authoritative Runtime evidence. No automatic clearing or new-key retry is permitted. The current Runtime has no verified reconciliation API, so unknown rows can remain quarantined indefinitely.

This Hub-only containment does not eliminate the need for Runtime idempotency and is not an exactly-once guarantee.

### 16.4 Corrections to the review record

- The existing owner token is a random UUID. It is sufficient as a Hub-local compare-and-set capability when every mutation checks the current owner. The baseline defect was the unconditional stale-owner UPSERT.
- No downstream fencing guarantee is claimed. A monotonic generation is required only if a downstream service is to reject stale owners across that service boundary.
- A durable `unknown` state prevents automatic lease-based takeover, but cannot by itself determine whether a write happened. It is a quarantine/reconciliation state, not proof of persistence.
- A 24-hour maximum lease bounds only the pending claim lifetime. It must never be used as an automatic expiry rule for `unknown` outcomes.


## 17. Implementation and verification status (2026-11-13)

### 17.1 Hub implementation

Implemented on `fix/unknown-state-hard-lease-2026-11-13`:

- `DedupStore`: `pending | unknown | committed`, owner-bound `markUnknown`, owner-bound commit, non-expiring UNKNOWN quarantine, no release/purge/add resolution of UNKNOWN, strict lease/TTL conversion, and safe absolute expiry.
- SQLite: additive `unknown_since` migration, durable quarantine across restart, index for UNKNOWN telemetry, and constructor cleanup retained.
- Auto-Memory: UNKNOWN transition before network dispatch, fail-closed behavior if transition fails, no automatic retry after ambiguous outcome, and no owner-blind UPSERT fallback.
- Diagnostics: UNKNOWN count, oldest UNKNOWN timestamp, and derived effective lease milliseconds; no hashes or owner capabilities exposed.
- Time budget: strict environment parsing, positive safe integer millisecond validation, exact minute conversion, 1,000 ms reserve, and a hard 86,400,000 ms effective lease cap.
- Brain client: validates the complete documented `BrainEntry` response before considering a 2xx save confirmed. Malformed 2xx responses remain ambiguous.
- Tests: deterministic expiry, restart, stale owner, lost response, pre-dispatch failure, response validation, strict configuration, lease boundary, and TTL cases.

### 17.2 Verification

The exact implementation/test SHA `263538e37a7f10d672c0eaba806f72899cdb136d` passed CI run `43469564256`:
- Node 22, 24, and 26: typecheck, 173 unit tests, and build passed.
- Dependency audit gate passed.
- The final state-machine cycle verifies that only `unknown -> committed` is permitted; `commit(pending)` fails, and `add` has no owner-token overload.
- TDD red/green cycles were recorded in `docs/reviews/2026-11-13-claim-timeout-idempotency-verification.md`.

The deterministic PR #5 two-child-process SQLite barrier test section was compared byte-for-byte and remains unchanged. PR #5 and PR #8 heads remain unchanged.

### 17.3 Remaining blockers

- Deployed Runtime identity and endpoint compatibility remain `UNVERIFIED`.
- The inspected `Activi-AI/The-Brain` source has no transactional idempotency implementation and its API route differs from the Hub contract.
- The connected GitHub identity has read-only access to that Runtime repository.
- No authoritative Runtime idempotency lookup or reconciliation API is available in the inspected source.
- End-to-end exactly-once persistence remains `UNVERIFIED`.
- Claude independent review was unavailable; this work has internal adversarial review and CI evidence, not third-party approval.
- No merge or deployment was performed.
