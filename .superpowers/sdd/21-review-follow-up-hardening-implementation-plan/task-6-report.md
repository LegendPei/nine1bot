# Task 6 Report

## Status

Complete. Implemented on `feat/gitlab-review-workflow` from base `5ef8ee3f7ad356df3a6bc571588963d8da8da7a6`.

## Changed Behavior And Files

- `packages/nine1bot/src/review/run-store.ts`
  - Added persisted `ReviewRunPublication` state with `publishing`, `partial`, and `published` transitions.
  - Added synchronous `claimPublication`, `recordPublicationMarker`, `failPublication`, and `completePublication` operations.
  - Every publication checkpoint/failure/completion conditionally matches `runId + claimId + ownerId + payloadHash` and reports success with a boolean.
  - Claims are saved before returning. Same-owner active claims reject concurrent publishers; partial or different-owner abandoned claims resume only for the same payload hash.
  - Completion atomically writes publication state, `publishedAt`, warnings, cleared error, and the stage terminal status.
  - Returned records clone nested publication data so callers cannot mutate persisted claim identity or marker checkpoints.
- `packages/nine1bot/src/review/gitlab-controller.ts`
  - Computes a SHA-256 hash from the parsed stage result and uses a process-stable publisher owner ID, with an explicit owner override for deterministic restart tests.
  - Preserves rejected attempts as terminal before any GitLab access and retains the authoritative MR HEAD check before claim/publication.
  - Reconciles resumed commit publications through commit comments only; MR publications reconcile bounded notes plus discussions.
  - Uses Task 5 marker helpers to identify only expected summary, fallback, and finding markers from projected `{ id, body }` DTOs.
  - Wraps publisher writes with claim checks before and after every network await, checkpoints each successful marker conditionally, and returns a stable claim-lost error for stale owners.
  - Converts publish or reconciliation failures to retryable partial state without writing an unmarked failure note.
- `packages/nine1bot/src/review/gitlab-controller.test.ts`
  - Added deterministic deferred-promise coverage for concurrent publishers, partial inline failure/resume, reconciliation failure, payload mismatch, abandoned owner recovery, stale owner mutations, terminal HEAD replay, and configuration-attempt immutability.
  - Tests assert exact GET/POST counts, routes, and deterministic markers.
- `opencode/packages/opencode/src/server/routes/webhooks.ts`
  - Prevents late runtime callbacks from changing any publication-owned run state.
  - Maps publication in-progress, payload mismatch, and stale-claim conflicts to HTTP 409.
- `opencode/packages/opencode/test/server/webhooks-status.test.ts`
  - Added publication-state callback guards and HTTP 409 mapping coverage.

## RED Evidence

1. Initial exact focused command:
   - `bun test packages/nine1bot/src/review/gitlab-controller.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`
   - Result: `66 pass, 6 fail, 225 expect() calls`.
   - Failures were causal: no claim existed at the gated first POST, no partial checkpoint existed after inline 5xx, store claim methods were absent for reconciliation/mismatch/restart tests, and publish conflict errors mapped to HTTP 400.
2. Late runtime callback guard:
   - `bun test opencode/packages/opencode/test/server/webhooks-status.test.ts --test-name-pattern "preserves publication-owned states"`
   - Result: `0 pass, 1 fail`; the partial publication received a late failed-status patch.
3. Terminality self-review additions:
   - `bun test packages/nine1bot/src/review/gitlab-controller.test.ts --test-name-pattern "configuration-rejected attempt|bounded metadata no longer matches"`
   - Result: `0 pass, 2 fail`; a configuration-rejected run published successfully, and a policy-rejected replay still made a GitLab HEAD request.

## GREEN Evidence And Verification

- Exact focused suite: `74 pass, 0 fail, 269 expect() calls`.
- Full maintained repository suite: `486 pass, 0 fail, 1694 expect() calls`.
- Platform GitLab contract suite: `91 pass, 0 fail, 281 expect() calls`.
- `bun run typecheck` in `packages/nine1bot`: passed (`tsc --project tsconfig.check.json`).
- `bun run typecheck` in `opencode/packages/opencode`: passed (`tsgo --noEmit`).
- `git diff --check`: passed; Git emitted only the repository's Windows LF-to-CRLF working-copy notices.

## State Transition And Crash-Window Reasoning

- Fresh publication: no publication -> synchronous persisted `publishing` claim -> Task 5 marker checkpoints -> atomic `published` plus terminal run state.
- Concurrent same-process publication: both callers may independently revalidate MR HEAD, but the first persisted claim wins before any publication/reconciliation request; the second receives `review_run_publish_in_progress` and performs zero POSTs.
- Partial failure: each successful POST is followed by a conditional marker checkpoint. A later failure atomically releases only the matching claim into `partial`; the same payload can claim again, while a different payload is rejected.
- Crash after remote POST but before local checkpoint: a new owner claims the abandoned publication, reads bounded remote markers, checkpoints confirmed markers, and posts only missing items.
- Stale owner: every read/write await is surrounded by claim checks. A stale callback cannot checkpoint, fail, or complete after a new claim, and a failed conditional mutation is surfaced rather than ignored.
- Reconciliation failure: the matching claim becomes `partial`, no publication POST is attempted, and the stable GitLab reconciliation diagnostic remains available for same-payload retry.
- Completion: controller confirms the summary marker and publisher completion, then one store mutation writes `publication.state=published`, clears claim/error fields, sets `publishedAt`, and writes the stage-appropriate `succeeded`, `blocked`, or `failed` status.
- MR HEAD: publication HEAD validation remains before claim. Policy/configuration rejected runs return their stored terminal error before any later network access, so old attempts cannot be revived.

## Self-Review

- Conditional mutation return values are checked at every controller call site; stale failures never overwrite a newer claim.
- The guarded publisher client checks ownership in `finally`, including GitLab 400 inline fallback paths, so claim loss during a failed inline await cannot proceed to an old-owner fallback POST.
- MR reconciliation reads notes and discussions; commit reconciliation reads only commit comments and recognizes only the summary marker.
- Payload hashing occurs after schema parsing, so unknown input fields do not alter publication identity and partial retries cannot switch normalized review results.
- The OpenCode runtime guard prevents session-created, controller-response, finish, CI-diagnostic, and failure callbacks from overwriting publishing, partial, or published state.
- The independent read-only Codex CLI review was attempted but could not start because the installed CLI cannot decode the current model/service-tier catalog. It was not counted as evidence; the diff instead received the manual invariant audit above plus full automated verification.

## Concerns

No implementation concerns. Multi-instance services sharing one JSON store remain explicitly outside the approved design; owner replacement assumes a process restart, not a supported split-brain deployment.

## Fix Round 1

### Status

Complete on top of `d265a471f5e2d6b3dcf4477bd6b4f67e9b5f51ee`.

### Finding Resolutions

1. **I1 terminal race**
   - Publication now re-reads the run immediately after token-secret resolution, after both successful and failed MR HEAD awaits, and once more directly before synchronous `claimPublication`.
   - There is no await between the final terminal check and claim. A policy/configuration rejection always returns its stored diagnostic without creating a claim or issuing a publication POST.
   - Deferred tests reject the run while secret resolution and MR HEAD are blocked and assert the preserved diagnostic, absent publication state, and exact zero-POST behavior.
2. **I2 live-owner takeover**
   - The store now tracks active claim identity in memory in addition to persisted publication state.
   - Any live in-process claim rejects a second owner. `reloadForTesting` clears only the ephemeral liveness layer, so a persisted same-payload claim left by restart can be replaced immediately.
   - Every post-claim marker, failure, reconciliation-marker replacement, and completion mutation requires the full persisted and active `runId + claimId + ownerId + payloadHash` identity.
   - Tests distinguish a live A/B race from a real store reload and assert that owner B performs one allowed HEAD read but zero publication POSTs while A remains active.
3. **I3 aggregate marker mismatch**
   - `aggregateGitLabReviewPublicationFindings` is exported from the publisher and used by both publication and reconciliation before deriving inline markers.
   - A duplicate-finding crash-window test verifies merged body and escalated severity, exposes only the aggregate marker remotely, leaves the local checkpoint absent, and resumes with zero duplicate POSTs.
4. **I4 stale local markers**
   - Resume begins with an empty in-memory completion set. Successful bounded reconciliation conditionally replaces the persisted marker checkpoint with only remotely observed expected markers.
   - Publisher callbacks then add markers posted by the current claim. A local marker absent remotely can neither suppress a POST nor satisfy completion.
   - A stale-summary test checkpoints locally, returns empty remote notes, and verifies exactly one restorative summary POST before atomic completion.
5. **I5 pagination claim guards**
   - `GitLabRequestOptions` has a narrow optional `requestGuard`; paginated requests invoke it immediately before and in `finally` after every page request.
   - Reconciliation passes the current-claim assertion to both bounded note and discussion listings. Claim loss after page 2 stops page 3, makes zero publication POSTs, leaves owner B untouched, and returns stable `review_run_publish_claim_lost`.
   - Platform tests verify the guard call boundary directly. OpenCode status tests now assert the claim-lost diagnostic maps to HTTP 409.
6. **Persistence hardening and callback gaps**
   - Nested persisted publication state is validated and normalized. Malformed marker collections are discarded as unpublished usable state; incomplete publishing identities are safely downgraded to partial; summary markers are normalized canonically.
   - Every publication mutation snapshots the complete in-memory record map, sequence, and ephemeral active claims. A synchronous write/rename failure restores all snapshots before rethrowing.
   - Real filesystem rename-failure tests cover claim, checkpoint, failure, and completion rollback, including liveness preservation and successful retry after the target is repaired.

### RED Evidence

- Test-first command before production edits:
  - `bun test packages/nine1bot/src/review/gitlab-controller.test.ts packages/platform-gitlab/test/gitlab-review.test.ts opencode/packages/opencode/test/server/webhooks-status.test.ts`
  - Result: `165 pass, 10 fail, 569 expect() calls`.
- The failures were causal and mapped one-to-one to the review findings:
  - Pagination guard promise resolved instead of rejecting and the controller fetched page 3 after claim loss.
  - Malformed `completedMarkers` threw while cloning a loaded run.
  - Failed claim and marker renames left mutated in-memory publication data.
  - Live owner B replaced owner A and entered reconciliation.
  - Secret and HEAD races returned later HEAD/publication failures instead of the stored terminal diagnostic.
  - Aggregate reconciliation attempted a duplicate inline POST.
  - A stale local summary checkpoint suppressed the required restorative POST.
- This initial unmodified-production run also serves as mutation evidence: removing the corresponding guards, normalization, rollback, canonical aggregation, or remote replacement reproduces the observed failure at the exact behavioral assertion.

### GREEN Evidence And Verification

- Combined fix suite: `175 pass, 0 fail, 599 expect() calls`.
- Exact Task 6 focused suite: `83 pass, 0 fail, 314 expect() calls`.
- Full platform-gitlab suite: `112 pass, 0 fail, 366 expect() calls`.
- Full maintained repository suite: `496 pass, 0 fail, 1742 expect() calls` across 59 files.
- `packages/platform-gitlab` typecheck: passed (`tsc --noEmit`).
- `packages/nine1bot` typecheck: passed (`tsc --project tsconfig.check.json`).
- `opencode/packages/opencode` typecheck: passed (`tsgo --noEmit`).
- `git diff --check`: passed; only the repository's Windows LF-to-CRLF working-copy notices were emitted.

### State Transition And Crash-Window Review

- Fresh claim: terminal re-check -> synchronous in-memory/persisted `publishing` claim -> network publication. Persistence failure rolls back both record and liveness, so a retry is usable.
- Live collision: persisted identity plus the ephemeral active map reject all takeover attempts in the current process. No age/timer heuristic is involved.
- Restart recovery: reload clears ephemeral liveness but retains the persisted claim. Same payload may acquire a new claim; payload mismatch remains terminal for publication and performs no reconciliation POST.
- Resume reconciliation: every page checks current identity before and after its await. Only a complete successful remote read can replace local checkpoints; read failure preserves retryable partial state.
- POST crash window: a remote marker generated from the canonical aggregate suppresses a duplicate POST even when its local checkpoint is missing. Conversely, a local-only marker is removed from the active completion set and must be restored remotely.
- Stale owner: callback, reconciliation replacement, failure, and completion all return false unless both persisted and active identities match. Controller converts lost ownership to the stable claim-lost diagnostic without mutating the replacement claim.
- Completion: the publisher has either confirmed or posted each required marker, the summary marker is present in the authoritative/current set, and one conditional store mutation writes `published`, `publishedAt`, warnings, cleared error, and the stage terminal status.

### Self-Review

- Confirmed no await exists between the final terminal-state read and `claimPublication`; the claim itself remains synchronous and persists before returning.
- Audited every reconciliation and publication network await for before/after ownership conditions, including page-level pagination and GitLab 400 inline fallback flow.
- Confirmed a claim-lost exception raised in a page `finally` takes precedence over a concurrent GitLab error, preserving HTTP 409 rather than leaking a 502 mapping.
- Confirmed remote reconciliation failure occurs before marker replacement or publication POST and releases only the matching active claim to partial.
- Confirmed malformed persisted publication data cannot reach clone/spread operations and cannot wedge payload identity.
- Confirmed the production boundary remains a single service process with one JSON store; no multi-instance lease semantics, timers, or cross-process liveness claims were introduced.

### Concerns

No implementation concerns. Multi-instance processes concurrently sharing the same JSON file remain explicitly out of scope; ephemeral owner liveness is intentionally process-local.
