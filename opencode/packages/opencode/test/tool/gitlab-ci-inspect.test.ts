import { describe, expect, test } from "bun:test"
import { createGitLabCiInspectTool } from "../../src/tool/gitlab-ci-inspect"
import type { Tool } from "../../src/tool/tool"

const context: Tool.Context = {
  sessionID: "session-review-1",
  messageID: "message-1",
  agent: "platform.gitlab.pm-coordinator",
  abort: new AbortController().signal,
  cwd: process.cwd(),
  extra: {},
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("gitlab_ci_inspect tool", () => {
  test("derives review identity from the tool session and exposes only bounded actions", async () => {
    const calls: Array<{ sessionId: string; request: unknown }> = []
    const tool = createGitLabCiInspectTool({
      async inspect(sessionId, request) {
        calls.push({ sessionId, request })
        return {
          ok: true,
          action: "list",
          observedAt: 1,
          target: {
            host: "gitlab.example.com",
            projectId: 3,
            mrIid: 10,
            headSha: "head-a",
          },
          pipeline: { id: 55, sha: "head-a", status: "success" },
          jobs: [{ id: 56, name: "build", status: "success" }],
          diagnostics: [],
        }
      },
    })
    const initialized = await tool.init()

    const result = await initialized.execute({ action: "list" }, context)

    expect(calls).toEqual([{
      sessionId: "session-review-1",
      request: { action: "list" },
    }])
    expect(result.title).toBe("GitLab CI inspection")
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      action: "list",
      pipeline: { id: 55 },
      jobs: [{ id: 56, status: "success" }],
    })
    expect(result.metadata).toEqual({ truncated: false })

    for (const forbidden of [
      { action: "list", token: "secret" },
      { action: "list", runId: "review-1" },
      { action: "list", url: "https://attacker.example" },
    ]) {
      await expect(initialized.execute(forbidden as any, context)).rejects.toThrow("invalid arguments")
    }
    expect(calls).toHaveLength(1)
  })

  test("marks bounded job-log output as already truncated so generic persistence is skipped", async () => {
    const tool = createGitLabCiInspectTool({
      async inspect(sessionId, request) {
        expect(sessionId).toBe("session-review-1")
        expect(request).toEqual({ action: "read_job_log", jobId: 57 })
        return {
          ok: true,
          action: "read_job_log",
          observedAt: 2,
          target: {
            host: "gitlab.example.com",
            projectId: 3,
            mrIid: 10,
            headSha: "head-a",
          },
          job: { id: 57, name: "test", status: "failed" },
          trace: "bounded trace",
          bytes: 13,
          truncated: true,
          diagnostics: [],
        }
      },
    })
    const initialized = await tool.init()

    const result = await initialized.execute({ action: "read_job_log", jobId: 57 }, context)

    expect(result.metadata).toEqual({ truncated: true })
    expect(result.metadata).not.toHaveProperty("outputPath")
    expect(result.output).toContain("bounded trace")
  })
})
