# Independent review — PR #10 (PR5-F1 / transport classification)

- Repository: `mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub`
- PR: https://github.com/mohammadrezayaghoobi123-dev/Master-Brain-MCP-Hub/pull/10
- Reviewed head at start: `ee01164b269815f949d27551185a79841e2bb268`
- Base: `788ee394bb95b58d4a8ab5b4c59b5e20caf84a99`
- Review mode: read-only source/diff/CI inspection; no local independent execution of the repository test suite.
- Review date: 2026-11-14

## 1. Scope and method

Inspected the PR metadata and unified diff, compared the exact head to the stated base, read `src/brain/client.ts` and `tests/brain-client-real-socket.test.ts`, and inspected the exact-head GitHub Actions run `43560445396` including job logs for Node 22, 24, and 26 and npm audit.

The PR is one commit ahead of the intended PR #5 head, with no base divergence. It changes the HTTP client and adds a real-socket regression test file.

## 2. Finding PR5-F1 — disposition

**Code-level assessment: RESOLVED by the proposed change, subject to the test evidence described below.**

The client sets Fetch redirect mode to:
- `follow` only when the effective method is GET;
- `error` for every other method.

This prevents a POST/other write from following a 3xx to a second hop. A failure caused by the redirect policy has no `requestDisposition: not_dispatched` marker in the inspected implementation, so the middleware does not owner-revert UNKNOWN. This closes the specific path in which the first server received a write, the redirect target failed to resolve/connect, and the original write was incorrectly treated as never dispatched.

The real-socket tests cover:
1. a closed loopback port producing a genuine ECONNREFUSED;
2. a 307 response from a first-hop server to an unreachable target, where the first hop receives the request and the client does not mark it pre-dispatch;
3. the middleware path retaining UNKNOWN and rejecting a retry without a second first-hop request;
4. GET continuing to follow redirects.

The regression tests are materially stronger than fetch-mock-only tests for this network boundary. The two redirect regression cases were reported by the PR author to fail on the base and pass on the proposed branch; this reviewer inspected the test construction and CI evidence but did not independently rerun the base branch.

## 3. Exact-head CI

Run `43560445396` is associated with head `ee01164b269815f949d27551185a79841e2bb268`. The logs show:
- Node 22.23.4: typecheck, 183 tests across 7 files, build — PASS.
- Node 24.22.2: typecheck, 183 tests across 7 files, build — PASS.
- Node 26.13.1: typecheck, 183 tests across 7 files, build — PASS.
- npm audit moderate-plus job — PASS.

This establishes CI success for the exact reviewed head. It does not establish deployed Backend behavior or end-to-end persistence semantics.

## 4. PR5-F2 — narrowed, not fully closed

The real-socket ECONNREFUSED test runs in the Node 22/24/26 CI matrix and confirms the actual error code and `not_dispatched` classification on all three versions.

However, this PR does not add real-socket CI tests for ENOTFOUND or EAI_AGAIN. Existing synthetic-cause tests do not establish the real Undici error shape for those codes on all supported Node versions.

**Correct status:** ECONNREFUSED real-socket shape verified on Node 22/24/26; ENOTFOUND and EAI_AGAIN remain UNVERIFIED by real-socket CI. The PR title/body must not claim PR5-F2 is fully closed.

## 5. Historical probe correction

The earlier follow-up audit's initial port-1 probe was invalid as proof of ECONNREFUSED because Fetch rejects port 1 as a bad port. The reviewer record on PR #5 has been corrected to distinguish that invalid initial probe from the later genuine closed-loopback-port reproduction verified in this PR's CI.

## 6. Remaining PR5 risks — not addressed by PR #10

- N3: HTTP statuses remain UNKNOWN; no authoritative Backend contract permits classifying them as no-write.
- F3: no operator reconciliation path or growth alert for UNKNOWN.
- M3: better-sqlite3 lock/busy behavior and event-loop blocking remain unmeasured.
- L1: strict response validation can leave a successfully stored but contract-drifted 2xx as UNKNOWN.
- L3: concurrent migration and mixed-version deployment remain unverified.
- Runtime handling of `Idempotency-Key` and deployed endpoint compatibility remain UNVERIFIED.
- No exactly-once guarantee is established.

## 7. Review disposition

- PR5-F1: **RESOLVED at code level** by refusing redirects for non-GET requests; exact-head CI is green.
- PR5-F2: **PARTIALLY VERIFIED**; only ECONNREFUSED is covered by real-socket CI across the matrix.
- PR #10: **do not merge yet** until its PR description is corrected to narrow the F2 claim and the corrected documentation commit receives exact-head CI.
- PR #5: remains not approved for merge while its other open findings and independent-review disposition remain unresolved.

No merge, deployment, Runtime write, force-push, or branch deletion was performed.


## 8. Post-review verification addendum

After the initial review:
- The PR description was corrected to state that PR5-F2 is only partially verified; it no longer claims full closure.
- The PR title was narrowed to PR5-F1 and the real-socket ECONNREFUSED coverage.
- The historical port-1 probe correction was committed to the PR #5 follow-up report.
- The final branch head at this addendum is `ec7637dfcf7d9438b77edaf607d9f91c50eb03c0`.
- Exact-head CI run `43562172251` completed successfully: Node 22, 24, and 26 typecheck/test/build jobs and npm audit all passed; each Node job ran 183 tests across 7 files.

The initial procedural conditions in section 7 for accurate PR wording and exact-head CI have therefore been met. This does **not** upgrade PR5-F2 beyond PARTIALLY VERIFIED, establish ENOTFOUND/EAI_AGAIN behavior, or verify the Backend/runtime contract. PR #10 remains Draft and unmerged. This independent review does not authorize merging PR #10 into PR #5 or PR #5 into its base.
