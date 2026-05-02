# GitLab Review Current State And Next Plan

## Purpose

This document freezes the current implementation state against the original GitLab code review design, then lists the next build steps.

The feature remains intentionally plugin-shaped:

- GitLab-specific parsing, API access, diff rules, agents, skills, and publishing live in `packages/platform-gitlab`.
- Nine1Bot product/controller glue lives in `packages/nine1bot/src/review`.
- Runtime execution remains generic. It receives agent/session/context/resource inputs; it does not import GitLab review business types.

## Implemented

### Platform GitLab Foundation

Implemented in `packages/platform-gitlab`:

- Runtime source declaration for GitLab review assets:
  - agents: `platform.gitlab`, `recommendable`, `platform-enabled`
  - skills: `platform.gitlab`, `declared-only`, `platform-enabled`
- GitLab review settings in the platform descriptor:
  - disabled by default
  - bot mention
  - webhook auto review
  - inline comments
  - dry-run
  - allowed project ids
  - webhook secret
  - GitLab API token
  - base URL
- Migrated review assets:
  - PM primary agent: `agents/review/pm-coordinator.agent.md`
  - subagent prompt skills: `skills/review/subagent-prompts/*/SKILL.md`
  - workflow/policy skills under `skills/review/*/SKILL.md`
- Dry-run harness:
  - `scripts/review-dry-run.ts`
  - fixtures for normal and overflow MR changes.

### Safety Rules From Design Review

Implemented:

- MR idempotency key includes `headSha`.
- Comment-triggered keys additionally include `noteId`.
- Diff builder filters noisy files:
  - lock files
  - build output
  - media/static large assets
  - generated files
- GitLab diff overflow/too-large blocks the review.
- Inline comments are validated against changed diff hunk lines before API calls.
- Invalid inline positions fall back to summary Markdown.
- GitLab inline API `400` falls back to summary Markdown.
- QA/Security/etc findings can be grouped deterministically by code before PM polishing.
- Runtime-facing result schema is passed as JSON-compatible schema; Runtime does not own GitLab `ReviewFinding` business types.
- Subagent task specs include `failureMode`.

### Webhook And Controller Entry

Implemented:

- Public GitLab webhook entry:
  - `POST /webhooks/gitlab`
- Authenticated review run inspection/publish API:
  - `GET /webhooks/gitlab/runs`
  - `GET /webhooks/gitlab/runs/:runId`
  - `POST /webhooks/gitlab/runs/:runId/publish`
- Product/controller glue:
  - `packages/nine1bot/src/review/gitlab-controller.ts`
  - `packages/nine1bot/src/review/run-store.ts`
- Current run store is in-memory and intentionally small.
- Webhook flow currently does:
  - validate GitLab webhook token
  - parse MR/note webhook
  - enforce settings and allowlist
  - compute idempotency key
  - dedupe accepted runs
  - load live MR changes when not dry-run
  - build review context
  - block and write GitLab comment on overflow
  - start Runtime session for non-dry-run, non-blocked runs

### Runtime Kickoff

Implemented:

- Non-dry-run, non-blocked GitLab review runs start an automated Runtime session.
- The session uses:
  - agent: `platform.gitlab.pm-coordinator`
  - GitLab review skills as session resources
  - context blocks from `GitLabReviewContext`
- Automated webhook controller input now supports `context.blocks`.

### Result Publishing

Implemented:

- `publishGitLabReviewRunResult` in product/controller layer.
- `publishGitLabReviewResult` in `packages/platform-gitlab`.
- Publisher posts:
  - validated inline discussions
  - final top-level summary note
  - inline fallback details in summary when needed
- Dry-run publishing is rejected without touching GitLab.

## Verification

Passing checks:

- `bun test` in `packages/platform-gitlab`
- `bun run typecheck` in `packages/platform-gitlab`
- `bun test packages/nine1bot/src/review/gitlab-controller.test.ts`
- `bun test packages/nine1bot/src/platform/manager.test.ts`
- `bun run review:dry-run fixtures/review/sample-mr-overflow.json`

Known verification caveat:

- `bun run typecheck` inside `opencode/packages/opencode` still fails because that package's standalone typecheck cannot resolve workspace package `@nine1bot/platform-protocol` when it imports Nine1Bot product-layer files. This is a monorepo typecheck boundary issue already visible in the current integration pattern, not a GitLab route type error.

## Design Comparison

| Area | Original plan | Current state | Gap |
| --- | --- | --- | --- |
| GitLab package boundary | GitLab-specific code in `platform-gitlab` | Implemented for parsing, diff, API, publishing, skills, agents | None for Phase 0/1 |
| Agents and skills | Runtime executes PM; PM spawns custom subagents using skills | Assets registered; Runtime starts PM session | PM prompt still needs deeper adaptation for actual subagent task tool contract |
| Web setting gate | Disabled by default and configured in platform UI | Descriptor exposes config; default disabled | Web layout is generic, no GitLab-specific helper UI yet |
| Webhook trigger | GitLab MR/note webhook and `@Nine1bot` | Public `/webhooks/gitlab` parses MR and note payloads | Commit diff fetching is not live yet |
| Idempotency | Must include MR `headSha` | Implemented and tested | Store is in-memory |
| Diff safety | Filter noise and block overflow | Implemented and tested | Need more GitLab API fixture coverage for real large MR payload variants |
| Inline safety | Validate hunk, fallback on invalid/400 | Implemented and tested | None for current scope |
| Map-reduce findings | Code-side grouping before PM | Aggregator implemented | Need wire actual multi-agent stage outputs into aggregator |
| Runtime boundary | Runtime accepts generic schema/results | Platform/controller own review types | Need actual PM result capture path |
| Failure policy | `failureMode` on subagent specs | Type and initial task specs exist | Runtime PM subagent creation contract still needs implementation/confirmation |
| Dry-run harness | Required early | Implemented | Could add CLI mode for webhook payload fixtures |

## Next Plan

### Step 1: Runtime Result Capture

Goal: make Runtime completion produce a structured review result that can call `publishGitLabReviewRunResult`.

Tasks:

- Decide the exact event or artifact channel for PM result output.
- Require PM agent to emit JSON matching `reviewStageResultJsonSchema`.
- Capture the final structured payload in the automated run monitor or controller event router.
- Call `publishGitLabReviewRunResult(runId, stageResult, ...)` on completion.
- Update `ReviewRunStore` with publish result.

### Step 2: PM And Skill Adaptation

Goal: make the migrated prompts truly match this project and the runtime source model.

Tasks:

- Rewrite `pm-coordinator.agent.md` around GitLab review, not generic implementation management.
- Tighten subagent prompt skills so they output the JSON schema consistently.
- Document allowed tools and failure modes per role.
- Keep code-writing agents disabled unless a future config explicitly allows fix mode.

### Step 3: Live GitLab Commit Review

Goal: support commit comment trigger beyond MR review.

Tasks:

- Add commit diff fetch method to `GitLabApiClient`.
- Build commit diff manifest using the same filter/overflow rules.
- Publish commit review notes via `repository/commits/:sha/notes`.
- Add fixtures and tests for commit note webhook.

### Step 4: Persistence

Goal: replace in-memory `ReviewRunStore`.

Tasks:

- Pick existing project storage pattern if available.
- Persist run records by `idempotencyKey`.
- Keep enough context for publish/retry:
  - trigger
  - diff refs
  - manifest
  - warnings
  - sessionId
  - turnSnapshotId
  - publish status

### Step 5: Web UX

Goal: make GitLab review setup understandable in the platform settings UI.

Tasks:

- Add GitLab-specific help text or custom component if the generic platform form is not enough.
- Show webhook URL for `/webhooks/gitlab`.
- Show review run status from `GET /webhooks/gitlab/runs`.
- Surface dry-run, blocked, duplicate, and published statuses.

### Step 6: End-To-End Test Harness

Goal: test the whole flow without a real GitLab project.

Tasks:

- Extend dry-run CLI to accept webhook payload fixtures.
- Mock GitLab API fetches for changes, notes, and discussions.
- Add a script that runs:
  - webhook parse
  - live changes fetch mock
  - Runtime prompt/context compile boundary
  - publish fallback paths

## Current Commit Stack

Current branch: `feat/gitlab-review-workflow`

Relevant commits:

- `f6e439e feat(gitlab): add review workflow foundation`
- `ce7d02d feat(gitlab): add review webhook entry`
- `8043ed9 feat(gitlab): run review workflow from webhook`
- `7e4aa9d feat(gitlab): publish review results`
- `afda183 feat(gitlab): expose review run publish api`
