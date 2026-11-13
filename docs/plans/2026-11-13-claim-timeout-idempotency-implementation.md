# Claim, Timeout, and Idempotency Hardening Implementation Plan

> **For agentic workers:** Execute task-by-task on this isolated branch. Preserve the existing PR #5 and PR #8 branches; do not merge or deploy.

**Goal:** Prevent the Hub from automatically retrying an ambiguous memory write after lease expiry, enforce a strict 24-hour maximum effective lease, and make ownership transitions fail closed.

**Architecture:** Add a durable `unknown` quarantine state to the Hub DedupStore. Transition the current owner from `pending` to `unknown` immediately before dispatch; never expire or purge `unknown`; only the same owner may transition it to `committed`. Validate all time budgets strictly and reject invalid or over-cap configurations. Runtime idempotency remains a separate blocked integration gate because the inspected Runtime repository does not implement it and is read-only to the connected GitHub identity.

**Tech Stack:** TypeScript, Node.js >=22.12, Vitest 5, better-sqlite3, GitHub Actions (Node 22/24/26).

## Global Constraints

- Preserve PR #5's SQLite constructor cleanup and deterministic two-child-process barrier test.
- Preserve the integrated PR #5 base and do not rewrite existing PR branches.
- `unknown` must never be released, expired, purged, or automatically retried.
- A failed `pending -> unknown` compare-and-set must prevent the external write from being dispatched.
- A confirmed save may commit only the same owner-bound row; stale owners must never UPSERT over a successor.
- No automatic retry with a new key while Runtime idempotency is unverified.
- Effective lease must be a finite safe integer in milliseconds and never exceed 86,400,000 ms.
- Missing timeout configuration may use documented defaults; supplied malformed, non-positive, unsafe, or over-cap values must throw `RangeError`.
- Failed `updateConfig` must not mutate caller input or partially replace valid configuration.
- No Runtime mutation, merge, deployment, branch deletion, or production operation.
- CI success on the exact final commit is required before describing Hub changes as passing.
- Exactly-once persistence remains `UNVERIFIED` until the deployed Runtime is identified and its transactional idempotency tests pass.

---

### Task 1: Durable UNKNOWN state and owner-bound store transitions

**Files:**
- Modify: `src/lib/dedup-store.ts`
- Test: `tests/dedup-two-phase.test.ts`

**Interfaces:**
- Extend `DedupState` to `'pending' | 'unknown' | 'committed'`.
- Extend `DedupStore` with `markUnknown(hash: string, token: string): boolean`.
- `status(hash)` returns `unknown` while the quarantined record exists.
- Keep the existing random owner token as a Hub-local compare-and-set capability. Do not claim downstream fencing.

- [x] **Step 1: Add focused failing tests**
  - For Memory and SQLite: claim -> markUnknown -> advance clock beyond 24 hours -> purge -> status remains `unknown`; a new claim returns null.
  - Wrong owner cannot mark unknown.
  - Correct owner can mark unknown exactly once; repeated transition returns false.
  - `release(hash, token)` cannot remove unknown.
  - Commit by the correct owner transitions unknown to committed.
  - Commit by a stale owner after another owner has claimed an expired pending row returns false and leaves the successor's pending row unchanged.
  - SQLite restart preserves unknown state and owner.
  - Purge removes expired pending/committed rows but never unknown rows.

- [x] **Step 2: Verify the relevant failure**
  - Run: `npm run test:run -- tests/dedup-two-phase.test.ts`
  - Expected: TypeScript/API failures for the missing `markUnknown` method and failing assertions showing that current expiry/purge removes ambiguous rows and stale commit overwrites a successor.

- [x] **Step 3: Implement the minimum behavior**
  - Add additive SQLite migration for the new `unknown` state; existing rows retain their current state and expiry semantics.
  - Represent unknown as non-expiring in store semantics; exclude it from expiry and purge predicates.
  - Implement owner-checked pending -> unknown compare-and-set in Memory and SQLite.
  - Restrict commit to a matching owner token and an existing pending/unknown row. Remove unconditional stale-owner UPSERT behavior.
  - Restrict token-bearing `add` to the matching owner row; it must not overwrite a different owner.
  - Keep release restricted to pending rows.
  - Keep schema migration idempotent and constructor cleanup intact.

- [x] **Step 4: Verify the focused pass**
  - Run: `npm run test:run -- tests/dedup-two-phase.test.ts`
  - Expected: all focused Memory/SQLite state-transition, expiry, restart, and ownership tests pass.

- [x] **Step 5: Run the affected integration check**
  - Run: `npm run typecheck`
  - Expected: no missing or incompatible DedupStore implementations.

- [x] **Step 6: Commit the passing deliverable**
  - Commit only `src/lib/dedup-store.ts` and `tests/dedup-two-phase.test.ts`.

### Task 2: Integrate quarantine state with Auto-Memory dispatch

**Files:**
- Modify: `src/middleware/auto-memory.ts`
- Test: `tests/dedup-two-phase.test.ts`

**Interfaces:**
- `processInteraction` returns reason `outcome_unknown` with `retryable: false` when a key is quarantined.
- Immediately before `brain.save`, call `markUnknown(hash, reservationToken)`.
- No network call is allowed unless that compare-and-set returns true.

- [x] **Step 1: Add focused failing tests**
  - After simulated backend commit + lost response, advance beyond the lease and invoke the same interaction: second Brain dispatch count remains one; result is `outcome_unknown`; state remains unknown.
  - A malformed 2xx response, transport reset, timeout, and every HTTP error class already covered leave unknown state and never retry automatically.
  - If `markUnknown` returns false, `brain.save` is never called and the result is `claim_lost`.
  - If the process crashes during analysis before dispatch, pending still expires and can be safely claimed again.
  - If the process crashes after transition to unknown but before dispatch, the row remains quarantined; this is a deliberate conservative false-positive requiring reconciliation.
  - Remove or rewrite the existing test that expects a second backend write after lease expiry; assert one backend write attempt instead.

- [x] **Step 2: Verify the relevant failure**
  - Run: `npm run test:run -- tests/dedup-two-phase.test.ts`
  - Expected: current code fails because it retries after expiry and has no unknown result state.

- [x] **Step 3: Implement the minimum behavior**
  - Query store status when claim acquisition fails; distinguish committed, pending, and unknown.
  - Mark unknown before dispatch and fail closed if ownership is lost.
  - Leave unknown untouched on any ambiguous outcome.
  - On confirmed save, commit only the same owner-bound unknown row.
  - Remove the unsafe fallback that calls token-bearing `add` after a failed commit; log a high-severity local persistence error and retain unknown if commit cannot be confirmed.
  - Do not add an automatic unknown reset or new-key retry path.

- [x] **Step 4: Verify the focused pass**
  - Run: `npm run test:run -- tests/dedup-two-phase.test.ts`
  - Expected: no second dispatch after ambiguous outcomes; pending pre-dispatch crash recovery still works.

- [x] **Step 5: Run the affected integration check**
  - Run: `npm run test:run -- tests/dedup-two-phase.test.ts tests/auto-memory.test.ts`
  - Expected: Auto-Memory behavior remains compatible except for the intentionally changed ambiguous-outcome retry contract.

- [x] **Step 6: Commit the passing deliverable**
  - Commit only `src/middleware/auto-memory.ts` and its focused tests.

### Task 3: Strict timeout parsing and effective lease cap

**Files:**
- Create: `src/lib/time-budget.ts`
- Modify: `src/brain/client.ts`
- Modify: `src/middleware/auto-memory.ts`
- Modify: `src/types/index.ts`
- Test: `tests/brain-client.test.ts`
- Test: `tests/dedup-two-phase.test.ts`

**Interfaces:**
- `MAX_EFFECTIVE_LEASE_MS = 86_400_000`.
- Shared helpers validate safe positive integer milliseconds, strictly parse supplied environment values, convert lease minutes to safe integer milliseconds, and derive the effective lease.
- `BrainClient` throws `RangeError` for a supplied invalid timeout; omission uses 30,000 ms.
- `AutoMemoryMiddleware` validates effective config atomically at construction and update.

- [x] **Step 1: Add focused failing tests**
  - BrainClient: omitted timeout uses 30,000 ms; NaN, infinities, zero, negative, fractional, unsafe, and malformed supplied values throw RangeError.
  - Environment: absent BRAIN_TIMEOUT_MS uses default; supplied malformed/empty/zero/negative/unsafe values fail closed.
  - AutoMemory: analysis timeout and claim lease accept valid safe values; invalid values throw RangeError.
  - Effective lease: exactly 86,400,000 ms accepted; 86,400,001 ms rejected.
  - Derived execution floor greater than cap rejected even when configured lease is within cap.
  - Configured lease below floor is raised deterministically to floor; equal and above-floor cases return expected value.
  - Invalid updateConfig leaves the prior effective config unchanged and does not mutate the caller's object.
  - Preserve the 1,000 ms scheduling/safety reserve as an explicit named constant; test the exact arithmetic.

- [x] **Step 2: Verify the relevant failure**
  - Run: `npm run test:run -- tests/brain-client.test.ts tests/dedup-two-phase.test.ts`
  - Expected: current implementation silently substitutes defaults and has no 24-hour cap, so the new RangeError and cap assertions fail.

- [x] **Step 3: Implement the minimum behavior**
  - Add pure validation/parsing functions in `time-budget.ts`.
  - Distinguish omitted environment settings from supplied malformed settings.
  - Validate milliseconds as positive safe integers; validate minute-to-millisecond conversion for overflow and integral precision.
  - Derive `max(configuredLeaseMs, analysisTimeoutMs + brainTimeoutMs + safetyMarginMs)`; reject values above the cap.
  - Validate a copied config object before replacing the active config; never mutate caller input.
  - Ensure BrainClient and AutoMemory consume the same parsed Brain timeout semantics.

- [x] **Step 4: Verify the focused pass**
  - Run: `npm run test:run -- tests/brain-client.test.ts tests/dedup-two-phase.test.ts`
  - Expected: all strict-boundary, environment parsing, atomic-update, and exact-cap tests pass.

- [x] **Step 5: Run the affected integration check**
  - Run: `npm run typecheck && npm run build`
  - Expected: clean typecheck and build.

- [x] **Step 6: Commit the passing deliverable**
  - Commit only the shared time-budget helper, client/config code, types, and corresponding tests.

### Task 4: Full Hub regression, branch comparison, and evidence record

**Files:**
- Modify: `docs/specs/2026-11-13-claim-timeout-idempotency-design.md`
- Create: `docs/reviews/2026-11-13-claim-timeout-idempotency-verification.md`

**Interfaces:**
- Evidence record identifies exact branch/head SHA, CI run IDs, commands, exit results, test totals, and unresolved Runtime gates.
- The review record distinguishes Hub-local guarantees from Runtime guarantees.

- [x] **Step 1: Add verification checklist**
  - Record exact expected properties: no ambiguous retry, unknown survives restart/purge, stale owner cannot overwrite, exact lease cap, strict config validation, legacy migration compatibility, and unchanged PR #5 barrier test.

- [x] **Step 2: Run full verification**
  - Run: `npm run typecheck`
  - Run: `npm run test:run`
  - Run: `npm run build`
  - Run: `npm audit --audit-level=moderate`
  - Expected: zero failures and zero audit findings at the configured threshold.

- [x] **Step 3: Verify exact-SHA CI**
  - Open a draft PR from this branch to `fix/integration-regressions-pr4-2026-11-13` only after the test-first commits exist.
  - Verify all Node 22/24/26 quality jobs and dependency audit on the exact final head SHA.
  - Record run IDs and results; do not infer results from an earlier SHA.

- [x] **Step 4: Verify branch preservation**
  - Compare the corrective branch against PR #5 and PR #8.
  - Confirm the PR #5 barrier test and constructor cleanup remain present.
  - Confirm PR #8 useful timeout-boundary cases are retained where compatible.
  - Confirm PR #5, PR #8, main, and Runtime branches were not modified.

- [x] **Step 5: Record unresolved Runtime gate**
  - The inspected `Activi-AI/The-Brain` implementation exposes `POST /api/memory/store`, performs direct INSERT, has no idempotency table/constraint, and has no real test suite.
  - Hub currently targets `/api/brain/entries`; deployed endpoint identity is unverified.
  - Runtime repository is read-only to the connected identity; no Runtime code change or deployment is allowed.
  - Set Runtime idempotency and end-to-end exactly-once to `UNVERIFIED`; do not mark Gate B or Gate C PASS.

- [x] **Step 6: Commit verification evidence**
  - Commit only the specification amendment and verification record.

---

## Unresolved external decisions and blockers

1. **Deployed Runtime identity:** It is not established whether `Activi-AI/The-Brain` is the service behind the configured production `BRAIN_API_URL`. A read-only deployment/configuration inspection or owner confirmation is required before changing endpoint contracts.
2. **Runtime write authority:** The connected GitHub identity has read-only permission on `Activi-AI/The-Brain`. Runtime implementation requires an authorized write path from the repository owner.
3. **Unknown-state reconciliation:** The inspected Runtime exposes no idempotency lookup or reconciliation endpoint. Until one is implemented and verified, unknown rows intentionally remain quarantined; no automatic retry is safe.
4. **Independent reviewer:** Claude review is unavailable due to the stated usage restriction. Internal adversarial review and CI evidence can proceed, but neither will be represented as an independent third-party approval.
5. **Merge/deploy:** This plan does not authorize merging any PR or deploying any Runtime or Hub service.


## Execution updates (2026-11-13)

The approved plan was executed on the isolated corrective branch with the following precision additions:

1. **UNKNOWN observability:** added persisted `unknown_since`, an index on `(state, unknown_since)`, `unknownStats()`, and safe `getStatus()` fields for UNKNOWN count/oldest time and effective lease. No hash or owner token is exposed.
2. **Response contract validation:** `BrainClient.save` now validates the full documented BrainEntry shape before the middleware can treat a 2xx response as confirmed. Malformed 2xx responses remain UNKNOWN.
3. **Store-level duration enforcement:** claim leases are validated at the DedupStore boundary, capped at 86,400,000 ms, and must convert to exact safe integer milliseconds. Dedup TTLs must also produce a safe absolute expiry timestamp.
4. **UNKNOWN resolution isolation:** `add()` has no owner-token overload and cannot transition UNKNOWN. `commit()` requires the matching owner and current `unknown` state; direct `pending -> committed` is rejected.
5. **PR #8 compatibility decision:** silent normalization/fallback behavior was intentionally not copied because it conflicts with the approved strict `RangeError` policy. Compatible TTL, boundary, and 24-hour-cap intent is covered by stricter tests.
6. **Verification:** CI red/green evidence and the exact verified code SHA are recorded in `docs/reviews/2026-11-13-claim-timeout-idempotency-verification.md`. The PR #5 two-process barrier test was compared byte-for-byte and preserved.

**Completion boundary:** Hub-local implementation and CI are complete. Runtime idempotency, deployed endpoint compatibility, and authoritative UNKNOWN reconciliation remain explicit external blockers; they are not marked PASS.
