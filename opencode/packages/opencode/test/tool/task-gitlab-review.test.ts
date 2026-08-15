import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import path from "path"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
import { RuntimeResourceResolver } from "../../src/runtime/resource/resolver"
import { RuntimeSourceRegistry } from "../../src/runtime/source/registry"
import { SessionRuntimeProfile } from "../../src/runtime/session/profile"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { Agent } from "../../src/agent/agent"
import { TaskTool } from "../../src/tool/task"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

const originalDisablePluginInstall = process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL
const originalDisableGlobalConfig = process.env.OPENCODE_DISABLE_GLOBAL_CONFIG

beforeAll(() => {
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
})

afterAll(() => {
  restoreEnv("OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL", originalDisablePluginInstall)
  restoreEnv("OPENCODE_DISABLE_GLOBAL_CONFIG", originalDisableGlobalConfig)
})

afterEach(() => {
  RuntimeSourceRegistry.clearForTesting()
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function registerGitLabReviewAgents() {
  RuntimeSourceRegistry.registerOwner({
    owner: {
      id: "gitlab",
      kind: "platform",
      enabled: true,
    },
    sources: {
      agents: [{
        id: "gitlab-review-agents",
        directory: path.resolve(import.meta.dir, "../../../../../packages/platform-gitlab/agents/review"),
        namespace: "gitlab",
        visibility: "declared-only",
        lifecycle: "platform-enabled",
      }],
    },
  })
}

function runtimeProfile(agent: string, template: string): SessionProfileSnapshot {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    source: "new-session",
    sourceTemplateIds: [template],
    agent: {
      name: agent,
      source: "internal-runtime",
    },
    defaultModel: {
      providerID: "test-provider",
      modelID: "test-model",
      source: "default-user-template",
    },
    context: { blocks: [] },
    resources: RuntimeResourceResolver.emptyResources(),
    permissions: {
      rules: {},
      source: [template],
      mergeMode: "strict",
    },
    sessionPermissionGrants: [],
    orchestration: { mode: "single" },
  }
}

function toolContext(sessionID: string, agent: string): Tool.Context {
  return {
    sessionID,
    messageID: "message-review-parent",
    agent,
    abort: new AbortController().signal,
    cwd: process.cwd(),
    extra: { bypassAgentCheck: true },
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

function mockTaskPrompt() {
  const message = spyOn(MessageV2, "get").mockResolvedValue({
    info: {
      role: "assistant",
      modelID: "test-model",
      providerID: "test-provider",
    },
    parts: [],
  } as any)
  const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
    parts: [{ type: "text", text: "specialist result" }],
  } as any)
  return () => {
    prompt.mockRestore()
    message.mockRestore()
  }
}

test("GitLab review TaskTool treats a foreign allow-all session ID only as a reference", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      registerGitLabReviewAgents()
      const root = await Session.createNext({
        directory: tmp.path,
        runtimeProfile: runtimeProfile("platform.gitlab.pm-coordinator", "gitlab-review-root"),
        runtimeCurrentModel: SessionRuntimeProfile.currentModel({
          providerID: "test-provider",
          modelID: "test-model",
        }, "session-choice"),
        client: {
          source: "webhook",
          platform: "gitlab",
          mode: "gitlab-code-review",
        },
      })
      const foreignProfile = runtimeProfile("general", "generic-webhook")
      foreignProfile.context.blocks.push({
        id: "foreign-context",
        layer: "project",
        source: "foreign-project",
        enabled: true,
        priority: 100,
        lifecycle: "session",
        visibility: "system-required",
        content: "foreign private history",
      })
      foreignProfile.resources.mcp.servers.push("foreign-network")
      const foreign = await Session.createNext({
        directory: path.join(tmp.path, "foreign-project"),
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        runtimeProfile: foreignProfile,
        client: {
          source: "webhook",
          mode: "generic-webhook",
        },
      })
      const restorePrompt = mockTaskPrompt()

      try {
        const task = await TaskTool.init()
        const result = await task.execute({
          description: "Review runtime boundary",
          prompt: "Inspect the supplied review context.",
          subagent_type: "platform.gitlab.risk-qa",
          session_id: foreign.id,
        }, toolContext(root.id, "platform.gitlab.pm-coordinator"))

        expect(result.metadata.sessionId).not.toBe(foreign.id)
        const specialistSession = await Session.get(result.metadata.sessionId)
        const specialistProfile = await SessionRuntimeProfile.read(specialistSession)
        const specialist = await Agent.get("platform.gitlab.risk-qa", { includeDeclaredOnly: true })

        expect(specialistSession).toMatchObject({
          parentID: root.id,
          projectID: root.projectID,
          directory: root.directory,
          client: root.client,
          runtime: { agent: "platform.gitlab.risk-qa" },
        })
        expect(specialistProfile).toMatchObject({
          sessionId: specialistSession.id,
          agent: { name: "platform.gitlab.risk-qa" },
          context: { blocks: [] },
          resources: {
            mcp: { servers: [] },
            skills: { skills: [] },
          },
          permissions: { mergeMode: "strict" },
          sessionPermissionGrants: [],
        })
        expect(specialistProfile?.sourceTemplateIds).toContain("gitlab-review-specialist")
        expect(specialist).toBeDefined()
        for (const permission of ["bash", "read", "webfetch", "browser_navigate", "mcp__foreign__read"]) {
          expect(PermissionNext.evaluate(
            permission,
            "*",
            specialist!.permission,
            specialistSession.permission ?? [],
          ).action).toBe("deny")
        }
        expect((await Session.get(foreign.id)).permission).toEqual([
          { permission: "*", pattern: "*", action: "allow" },
        ])

        const resumed = await task.execute({
          description: "Continue runtime review",
          prompt: "Continue the same focused review.",
          subagent_type: "platform.gitlab.risk-qa",
          session_id: specialistSession.id,
        }, toolContext(root.id, "platform.gitlab.pm-coordinator"))
        expect(resumed.metadata.sessionId).toBe(specialistSession.id)
      } finally {
        restorePrompt()
      }
    },
  })
})

test("generic TaskTool callers retain legitimate child-session reuse", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.createNext({
        directory: tmp.path,
        runtimeProfile: runtimeProfile("build", "generic-root"),
      })
      const child = await Session.createNext({
        parentID: root.id,
        directory: tmp.path,
        runtimeProfile: runtimeProfile("general", "generic-task"),
      })
      const restorePrompt = mockTaskPrompt()

      try {
        const task = await TaskTool.init()
        const result = await task.execute({
          description: "Continue generic task",
          prompt: "Continue the existing task.",
          subagent_type: "general",
          session_id: child.id,
        }, toolContext(root.id, "build"))

        expect(result.metadata.sessionId).toBe(child.id)
      } finally {
        restorePrompt()
      }
    },
  })
})
