import { describe, expect, test } from "bun:test"
import {
  gitLabReviewPublishStatus,
  gitLabReviewCiNotQueriedPatch,
  gitLabReviewRuntimeTools,
  gitLabReviewSessionCreatedPatch,
  publicGitLabReviewWebhookResult,
  publicGitLabReviewRun,
  resolveGitLabReviewRuntimeDirectory,
  webhookLocalOrigin,
} from "../../src/server/routes/webhooks"

describe("webhook status URL selection", () => {
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
        },
        diagnostics: ["failed_jobs_detected"],
      },
    })
  })

  test("maps GitLab review publish failures to specific HTTP statuses", () => {
    expect(gitLabReviewPublishStatus("review_run_not_found")).toBe(404)
    expect(gitLabReviewPublishStatus("review_run_already_published")).toBe(409)
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
})
