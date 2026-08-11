import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  rejectGitLabReviewRuntimeConfiguration,
  reportGitLabReviewRunFailure,
} from "../../../../../packages/nine1bot/src/review/gitlab-controller"
import { ReviewRunStore } from "../../../../../packages/nine1bot/src/review/run-store"
import {
  gitLabReviewPublishStatus,
  gitLabReviewCiNotQueriedPatch,
  gitLabReviewControllerResponsePatch,
  gitLabReviewRuntimePatch,
  gitLabReviewRuntimeTools,
  gitLabReviewRuntimeFailure,
  gitLabReviewSessionCreatedPatch,
  publicGitLabReviewWebhookResult,
  publicGitLabReviewRun,
  resolveGitLabReviewRuntimeDirectory,
  startGitLabReviewRuntime,
  startGitLabReviewRuntimeRun,
  webhookLocalOrigin,
} from "../../src/server/routes/webhooks"

describe("webhook status URL selection", () => {
  test("does not move a terminal GitLab review run back to running", () => {
    const response = {
      accepted: true,
      turnSnapshotId: "turn_fast_completion",
    } as any
    const run = {
      id: "run_terminal",
      status: "succeeded",
      publishedAt: 42,
    } as any

    expect(gitLabReviewControllerResponsePatch(run, response)).toBeUndefined()
    expect(gitLabReviewControllerResponsePatch({ ...run, status: "failed", publishedAt: undefined }, response))
      .toBeUndefined()
    expect(gitLabReviewControllerResponsePatch({ ...run, status: "running", publishedAt: undefined }, response))
      .toEqual({ status: "running", turnSnapshotId: "turn_fast_completion" })
  })

  test("preserves a rejected GitLab review when publication refuses a stale MR head", () => {
    const rejected = {
      id: "run_rejected",
      status: "rejected",
      error: "gitlab_review_head_changed",
    } as any

    expect(gitLabReviewRuntimePatch(rejected, {
      status: "failed",
      error: "gitlab_review_head_changed",
    })).toBeUndefined()
  })

  test("preserves publication-owned states across late runtime callbacks", () => {
    const patch = { status: "failed" as const, error: "late_runtime_failure" }
    const run = {
      id: "run_publication",
      status: "failed",
      publication: {
        state: "partial",
        payloadHash: "payload-a",
        summaryMarker: "summary-marker",
        completedMarkers: ["summary-marker"],
        updatedAt: 42,
      },
    } as any

    expect(gitLabReviewRuntimePatch(run, patch)).toBeUndefined()
    expect(gitLabReviewRuntimePatch({
      ...run,
      status: "running",
      publication: { ...run.publication, state: "publishing", claimId: "claim-b", ownerId: "owner-b" },
    }, patch)).toBeUndefined()
    expect(gitLabReviewRuntimePatch({
      ...run,
      status: "succeeded",
      publication: { ...run.publication, state: "published" },
    }, patch)).toBeUndefined()
  })

  test("normalizes runtime failures without exposing exception text", () => {
    expect(gitLabReviewRuntimeFailure("runtime_start", new Error("PRIVATE-TOKEN=secret at C:\\private\\config")))
      .toBe("gitlab_review_runtime_start_failed")
    expect(gitLabReviewRuntimeFailure("runtime_finished", "provider response with private prompt"))
      .toBe("gitlab_review_runtime_finished_failed")
  })

  test("uses configured local URL when provided", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096/",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("strips repeated trailing slashes from configured local URL", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096///",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("replaces loopback browser origin with a reachable LAN IPv4", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      interfaces: {
        Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
        Ethernet: [{ address: "192.168.53.6", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("keeps non-loopback origins unchanged", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://192.168.53.6:4096",
      interfaces: {
        Ethernet: [{ address: "10.0.0.12", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("omits heavy GitLab review context from list records", () => {
    expect(publicGitLabReviewRun({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      context: {
        diff: {
          files: [{ diff: "large diff" }],
        },
      },
      project: {
        id: "uftest",
        host: "gitlab.example.com",
        projectId: 3,
        nine1botProjectID: "project-uf",
        pathWithNamespace: "root/uftest",
        displayName: "UFtest",
        enabled: true,
        reviewContextMarkdown: "Internal review notes.",
        reviewFocus: ["auth"],
        includePathPrefixes: [],
        excludePathPatterns: [],
        ci: { maxJobLogs: 3, maxJobLogBytes: 8000 },
        source: "configured",
        matchedAt: 3,
      },
      ci: {
        pipeline: {
          id: 41,
          sha: "abc123",
          status: "failed",
          ref: "feature/review",
          web_url: "https://gitlab.example.com/root/uftest/-/pipelines/41",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
          trace: "must never reach the browser",
        },
        diagnostics: ["failed_jobs_detected"],
        trace: "must never reach the browser",
      },
    } as any)).toEqual({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      project: {
        id: "uftest",
        host: "gitlab.example.com",
        projectId: 3,
        nine1botProjectID: "project-uf",
        pathWithNamespace: "root/uftest",
        displayName: "UFtest",
        enabled: true,
        source: "configured",
        matchedAt: 3,
      },
      ci: {
        pipeline: {
          id: 41,
          sha: "abc123",
          status: "failed",
          ref: "feature/review",
          web_url: "https://gitlab.example.com/root/uftest/-/pipelines/41",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["failed_jobs_detected"],
      },
    })
  })

  test("maps GitLab review publish failures to specific HTTP statuses", () => {
    expect(gitLabReviewPublishStatus("review_run_not_found")).toBe(404)
    expect(gitLabReviewPublishStatus("review_run_already_published")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_publish_in_progress")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_publish_payload_mismatch")).toBe(409)
    expect(gitLabReviewPublishStatus("review_run_already_active")).toBe(409)
    expect(gitLabReviewPublishStatus("gitlab_api_publish_failed:403:Forbidden")).toBe(502)
    expect(gitLabReviewPublishStatus("invalid_stage_result")).toBe(400)
  })

  test("records a nonblocking diagnostic when runtime finishes without querying CI", () => {
    const patch = gitLabReviewCiNotQueriedPatch({
      id: "run_1",
      rootRunId: "run_1",
      attempt: 1,
      triggerKey: "trigger_1",
      generation: "generation_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      publishedAt: 3,
      warnings: ["existing warning"],
      trigger: { objectType: "mr" },
      ci: {
        pipeline: {
          id: 41,
          sha: "head",
          status: "success",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["existing_diagnostic"],
      },
    })

    expect(patch).toEqual({
      ci: {
        pipeline: {
          id: 41,
          sha: "head",
          status: "success",
          kind: "source",
          verification: ["mr_pipeline_candidate", "head_sha_exact"],
        },
        diagnostics: ["existing_diagnostic", "ci_not_queried"],
      },
    })
    expect(gitLabReviewCiNotQueriedPatch({
      id: "run_2",
      rootRunId: "run_2",
      attempt: 1,
      triggerKey: "trigger_2",
      generation: "generation_2",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      trigger: { objectType: "mr" },
      ci: { diagnostics: [], queryCount: 1 },
    })).toBeUndefined()
  })

  test("enables only the bounded GitLab CI tool in the automated review message", () => {
    expect(gitLabReviewRuntimeTools("mr")).toEqual({
      "*": false,
      task: true,
      gitlab_ci_inspect: true,
    })
    expect(gitLabReviewRuntimeTools("commit")).toEqual({
      "*": false,
      task: true,
      gitlab_ci_inspect: false,
    })
  })

  test("binds a fresh review session before runtime message delivery", () => {
    expect(gitLabReviewSessionCreatedPatch("session_new")).toEqual({
      status: "running",
      sessionId: "session_new",
      turnSnapshotId: undefined,
      error: undefined,
    })
  })

  test("keeps a rejected review terminal across runtime callback races without posting a failure note", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-rejection-"))
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const rejected = ReviewRunStore.create({
      platform: "gitlab",
      status: "rejected",
      error: "gitlab_review_head_changed",
      rejectionKind: "policy",
      recoverable: false,
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "stale-head",
        mode: "webhook",
      },
    })

    expect(gitLabReviewSessionCreatedPatch("session_late", rejected)).toBeUndefined()
    expect(gitLabReviewControllerResponsePatch(rejected, {
      accepted: false,
      turnSnapshotId: "turn_late",
    })).toBeUndefined()
    expect(gitLabReviewRuntimePatch(rejected, {
      status: "failed",
      error: "gitlab_review_head_changed",
    })).toBeUndefined()

    const calls: Array<{ url: string; init?: RequestInit }> = []
    await expect(reportGitLabReviewRunFailure({
      runId: rejected.id,
      platforms: { gitlab: { enabled: true, settings: {
        "review.enabled": true,
        "review.dryRun": false,
        "review.baseUrl": "https://gitlab.example.com",
        "review.tokenSecretRef": { provider: "nine1bot-local", key: "gitlab-token" },
      } } },
      secrets: {
        async get() { return "token" },
        async set() {},
        async delete() {},
        async has() { return true },
      },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json({ id: 1 })
      }) as typeof fetch,
      phase: "runtime_finished",
      error: "gitlab_review_runtime_finished_failed",
    })).resolves.toMatchObject({ notified: false, error: "review_run_policy_rejected" })
    expect(calls.filter((call) => call.init?.method === "POST")).toEqual([])
    expect(ReviewRunStore.get(rejected.id)).toMatchObject({
      status: "rejected",
      error: "gitlab_review_head_changed",
      recoverable: false,
    })
    await rm(directory, { recursive: true, force: true })
  })

  test("does not post when the actual runtime finished callback arrives after policy rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-callback-"))
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let finishedCallbackCalls = 0
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return Response.json({ id: 1 })
    }) as typeof fetch
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      error: "before_rejection",
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "trigger-head",
        mode: "webhook",
      },
    })

    try {
      await startGitLabReviewRuntimeRun({
        runId: run.id,
        idempotencyKey: "gitlab:gitlab.example.com:123:mr:10:head_sha:trigger-head:auto:merge_request",
        trigger: run.trigger as any,
        context: {
          project: { nine1botProjectID: "test-project" },
          diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
          contextBlocks: [],
        },
      } as any, directory, {
        platforms: {},
        runner: async (input: any) => {
          const onFinished = input.onFinished
          expect(onFinished).toBeDefined()
          ReviewRunStore.update(run.id, {
            status: "rejected",
            error: "gitlab_review_head_changed",
            rejectionKind: "policy",
            recoverable: false,
          })
          finishedCallbackCalls++
          await onFinished({ status: "failed", error: "late runtime failure" })
          return { accepted: true, sessionID: "session_late", status: 202, response: {} } as any
        },
      })

      expect(ReviewRunStore.get(run.id)).toMatchObject({
        status: "rejected",
        error: "gitlab_review_head_changed",
        recoverable: false,
      })
      expect(calls.filter((call) => call.init?.method === "POST")).toEqual([])
      expect(finishedCallbackCalls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("omits GitLab review context from the public webhook response", () => {
    expect(publicGitLabReviewWebhookResult({
      accepted: true,
      status: "accepted",
      idempotencyKey: "gitlab:mr:3:4:head",
      runId: "run_1",
      rootRunId: "run_0",
      attempt: 2,
      retryOf: "run_0",
      trigger: { host: "gitlab.example.com", projectId: 3, objectType: "mr", objectIid: 4, eventName: "note", mode: "mention" },
      warnings: [],
      context: {
        contextBlocks: [{ content: "FAILED secret trace" }],
        diff: { files: [{ diff: "private diff" }] },
      },
    } as any)).toEqual({
      accepted: true,
      status: "accepted",
      idempotencyKey: "gitlab:mr:3:4:head",
      runId: "run_1",
      rootRunId: "run_0",
      attempt: 2,
      retryOf: "run_0",
      trigger: { host: "gitlab.example.com", projectId: 3, objectType: "mr", objectIid: 4, eventName: "note", mode: "mention" },
      warnings: [],
    })
  })

  test("resolves GitLab review runtime directory from the bound Nine1Bot project", async () => {
    const requested: string[] = []
    const directory = await resolveGitLabReviewRuntimeDirectory(
      { nine1botProjectID: "project-uf" },
      async (projectID) => {
        requested.push(projectID)
        return { worktree: "C:/worktrees/uf", rootDirectory: "C:/repos/uf" }
      },
    )

    expect(requested).toEqual(["project-uf"])
    expect(directory).toBe("C:/repos/uf")
  })

  test("fails GitLab review runtime startup when its project binding is missing or stale", async () => {
    await expect(resolveGitLabReviewRuntimeDirectory(undefined, async () => {
      throw new Error("must not resolve")
    })).rejects.toThrow("project_binding_missing")

    await expect(resolveGitLabReviewRuntimeDirectory(
      { nine1botProjectID: "deleted-project" },
      async () => {
        throw new Error("not found")
      },
    )).rejects.toThrow("project_binding_missing")
  })

  test("keeps a stale runtime project binding recoverable without creating a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nine1bot-runtime-stale-binding-"))
    ReviewRunStore.setPathForTesting(join(directory, "review-runs.json"))
    ReviewRunStore.clearForTesting()
    const run = ReviewRunStore.create({
      platform: "gitlab",
      status: "running",
      trigger: {
        host: "gitlab.example.com",
        projectId: 123,
        objectType: "mr",
        objectIid: 10,
        headSha: "stale-binding-head",
        mode: "webhook",
      },
    })
    let sessionsCreated = 0

    try {
      const rejected = await startGitLabReviewRuntime({
        runId: run.id,
        idempotencyKey: "gitlab:gitlab.example.com:123:mr:10:head_sha:stale-binding-head:auto:merge_request",
        trigger: run.trigger as any,
        context: {
          project: { nine1botProjectID: "deleted-project" },
          diff: { files: [], skipped: [], blocked: false, stats: { fileCount: 0, includedFileCount: 0, skippedFileCount: 0, includedBytes: 0, truncated: false } },
          contextBlocks: [],
        },
      } as any, "runtime_start", {
        getProject: async () => {
          throw new Error("not found")
        },
        start: async () => {
          sessionsCreated++
        },
      })

      expect(sessionsCreated).toBe(0)
      expect(rejected).toMatchObject({ accepted: false, error: "project_binding_missing", httpStatus: 202 })
      expect(ReviewRunStore.get(run.id)).toMatchObject({
        status: "rejected",
        rejectionKind: "configuration",
        recoverable: true,
        attempt: 1,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
