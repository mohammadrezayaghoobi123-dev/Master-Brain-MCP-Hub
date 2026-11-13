# Verification Report — Claim, Timeout, and Idempotency Hardening

**Verification date:** 2026-11-13  
**Repository:** `mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub`  
**Branch:** `fix/unknown-state-hard-lease-2026-11-13`  
**Verified head:** `263538e37a7f10d672c0eaba806f72899cdb136d`  
**Pull request:** [#9 — claim/timeout/idempotency hardening](https://github.com/mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub/pull/9)  
**Base:** `fix/integration-regressions-pr4-2026-11-13` at PR #5 head `fea31f01b6b56e498a0f6a1f1c340c05ea8ca186`

## 1. Verification result

**HUB BRANCH: CI PASS**

The exact verified head was tested by GitHub Actions run [#110 / 43469564256](https://github.com/mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub/actions/runs/43469564256).

| Gate | Result | Evidence |
|---|---|---|
| Node.js 22 | PASS | Typecheck, 169 unit tests, build |
| Node.js 24 | PASS | Typecheck, 169 unit tests, build |
| Node.js 26 | PASS | Typecheck, 169 unit tests, build |
| Dependency audit | PASS | `npm audit --audit-level=moderate` workflow gate |
| Test files | 6 passed | Vitest summary |
| Unit tests | 173 passed | Vitest summary |
| Merge | NOT PERFORMED | PR remains open |
| Deployment | NOT PERFORMED | No deployment action taken |

This is CI evidence for the exact SHA above. It is not a production or Runtime end-to-end verification.

## 2. Implemented Hub invariants

### H-1 — Claim lifecycle

- `pending` is a pre-dispatch reservation and may expire.
- Immediately before external Brain dispatch, the current owner must atomically transition `pending -> unknown`.
- If that compare-and-set fails or throws, the external write is not dispatched.
- `unknown` never expires, is not purged, and blocks a new claim.
- `release` and ownerless `add` cannot remove or resolve `unknown`; `add` exposes no owner-token overload.
- `commit` requires the current owner and the `unknown` state; direct `pending -> committed` is rejected.
- A stale owner cannot UPSERT over a successor claim.
- SQLite persists `unknown` and `unknown_since`; the migration is additive/idempotent and the operational query has an index.
- Operational status exposes only UNKNOWN count and oldest timestamp; hashes and owner tokens are not exposed.

### H-2 — Ambiguous outcomes

A timeout, transport error, HTTP error without a documented no-write guarantee, unreadable response, or malformed 2xx response leaves the key quarantined as `unknown`. The Hub does not retry automatically after lease expiry.

### H-3 — Time budget

- Supplied timeout values must be positive safe integer milliseconds and within Node timer bounds.
- Missing environment values use explicit defaults; malformed supplied values fail closed.
- Lease minutes must convert exactly to safe integer milliseconds.
- The effective lease is `max(configuredLease, analysisTimeout + BrainTimeout + 1,000ms reserve)`.
- Configured and effective claim leases are capped at 86,400,000 ms.
- Invalid constructor/update configuration throws `RangeError`; update validation is atomic and does not mutate the caller's object.
- Store-level validation also rejects over-cap claim leases and unsafe TTL values.

### H-4 — Save response validation

A 2xx response is treated as confirmed only if it satisfies the documented `BrainEntry` response shape, including a non-empty ID, known memory type, content, string tags, valid source tool, and ISO timestamp. Malformed 2xx responses remain ambiguous and therefore UNKNOWN.

## 3. TDD evidence

| Cycle | Red evidence | Green evidence |
|---|---|---|
| UNKNOWN quarantine, no ambiguous retry, strict config | CI run `43466364534` / `c13f2082...` | CI run `43466794549` / `70b97576...` |
| UNKNOWN metrics and restart persistence | CI run `43467083294` / `dc97702a...` | CI run `43467292406` / `9e96189c...` |
| BrainEntry response validation | CI run `43467716362` / `0aa6f51c...` | CI run `43467980184` / `ae7f0c62...` |
| Store-level lease/TTL bounds and UNKNOWN resolution restriction | CI run `43468428759` / `aa8e9765...` | CI run `43469564256` / `263538e3...` |
| Explicit state-machine enforcement (UNKNOWN-only commit; ownerless add) | CI run `43469318955` / `86b96b66...` | Final CI run `43469564256` / `263538e3...` |

Red runs failed on the intended new assertions. Green runs passed the relevant tests and full quality matrix. The final run is the acceptance evidence.

## 4. Preservation and integration review

- PR #5 remains open and its head SHA remains `fea31f01b6b56e498a0f6a1f1c340c05ea8ca186`.
- PR #8 remains open and its head SHA remains `0d92e7653886e23617b0c7658faabf3e23b7880f`.
- The deterministic two-child-process SQLite barrier test section in PR #5 was compared byte-for-byte with this branch and is unchanged.
- The SQLite constructor cleanup test remains present.
- PR #9 is based directly on PR #5's head branch; it does not retarget or rewrite PR #5 or PR #8.
- PR #8's silent normalization/fallback semantics were intentionally not copied because the approved design requires strict `RangeError` rejection. Compatible TTL and boundary validation intent is covered by the new tests.
- No merge, deployment, branch deletion, or Runtime write was performed.

## 5. Runtime integration gate — UNVERIFIED

The accessible repository `Activi-AI/The-Brain` was inspected read-only.

Observed source facts:
- It exposes `POST /api/memory/store`.
- Its inspected storage handler performs a direct INSERT into `memories`.
- The inspected source contains no transactional idempotency record, unique idempotency-key constraint, or atomic coupling between an idempotency record and the memory row.
- Its test script is a placeholder; there is no real Runtime test suite in the inspected repository.
- The Hub client and its checked-in contract target `POST /api/brain/entries`.
- It has not been established that `Activi-AI/The-Brain` is the service deployed behind the Hub's configured `BRAIN_API_URL`.
- The connected GitHub identity has read-only access to `Activi-AI/The-Brain`.

Therefore:
- Runtime endpoint compatibility: **UNVERIFIED**.
- Runtime idempotency: **UNVERIFIED** for the deployed service; absent in the inspected The-Brain implementation.
- End-to-end exactly-once persistence: **UNVERIFIED**.
- Hub-local quarantine is a containment mechanism, not a substitute for Runtime idempotency.

## 6. Operational limitation and safety trade-off

UNKNOWN records intentionally remain quarantined indefinitely. This prevents automatic duplicate dispatch but can reduce availability and accumulate persistent rows. The current Runtime offers no authoritative idempotency lookup/reconciliation API, so the Hub must not clear these rows automatically. A safe reconciliation workflow is a remaining integration requirement.

The owner UUID is a Hub-local compare-and-set capability. No downstream fencing guarantee is claimed.

Claude review was unavailable due to the stated usage limit. This report is an internal adversarial engineering review plus CI evidence, not an independent third-party approval.

## 7. Final disposition

**Hub branch implementation:** verified by CI on the exact SHA above.  
**Runtime integration:** blocked by repository permission and unverified deployed target.  
**Production readiness:** NOT APPROVED.  
**Merge/deploy authorization:** not exercised or assumed.
