import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { RuntimeResourceResolver } from "@/runtime/resource/resolver"
import type { SessionProfileSnapshot } from "@/runtime/protocol/agent-run-spec"
import { SessionRuntimeProfile } from "@/runtime/session/profile"
import { ulid } from "ulid"

const GITLAB_REVIEW_SPECIALIST_TEMPLATE = "gitlab-review-specialist"
const GITLAB_REVIEW_SPECIALISTS = new Set([
  "platform.gitlab.developer",
  "platform.gitlab.frontend-designer",
  "platform.gitlab.risk-qa",
  "platform.gitlab.security-agent",
  "platform.gitlab.spec-writer",
  "platform.gitlab.tech-architect",
])

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      const agent = await Agent.get(params.subagent_type, { includeDeclaredOnly: true, includeRecommendable: true })
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const callerSession = await Session.get(ctx.sessionID).catch(() => undefined)
      const gitLabReviewRoot = Boolean(
        callerSession
        && ctx.agent === "platform.gitlab.pm-coordinator"
        && callerSession.client?.source === "webhook"
        && callerSession.client.platform === "gitlab"
        && callerSession.client.mode === "gitlab-code-review"
        && callerSession.runtime?.agent === "platform.gitlab.pm-coordinator",
      )
      if (gitLabReviewRoot && (!GITLAB_REVIEW_SPECIALISTS.has(agent.name) || agent.mode === "primary")) {
        throw new Error("gitlab_review_task_specialist_not_allowed")
      }

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const gitLabReviewBoundary = gitLabReviewRoot
      const permission = taskSessionPermission({
        agentPermission: agent.permission,
        hasTaskPermission,
        primaryTools: config.experimental?.primary_tools ?? [],
        gitLabReviewBoundary,
      })

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch(() => {})
          if (
            found
            && (!gitLabReviewBoundary || await isOwnedGitLabReviewSpecialistSession({
              session: found,
              owner: callerSession!,
              agentName: agent.name,
              permission,
            }))
          ) return found
        }

        if (gitLabReviewBoundary) {
          const runtime = await gitLabReviewSpecialistRuntime({
            owner: callerSession!,
            agent: {
              name: agent.name,
              model: agent.model,
            },
            permission,
          })
          return await Session.createNext({
            parentID: ctx.sessionID,
            title: params.description + ` (@${agent.name} subagent)`,
            directory: callerSession!.directory,
            permission,
            runtimeProfile: runtime.profile,
            runtimeCurrentModel: SessionRuntimeProfile.currentModel(runtime.model, "profile-snapshot"),
            client: callerSession!.client,
          })
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission,
        })
      })
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
            model,
          },
        })
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: gitLabReviewBoundary
          ? undefined
          : {
              todowrite: false,
              todoread: false,
              ...(hasTaskPermission ? {} : { task: false }),
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
            },
        parts: promptParts,
      })
      unsub()
      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((x: any) => x.type === "tool") as MessageV2.ToolPart[])
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})

function taskSessionPermission(input: {
  agentPermission: PermissionNext.Ruleset
  hasTaskPermission: boolean
  primaryTools: string[]
  gitLabReviewBoundary: boolean
}) {
  const taskRules: PermissionNext.Ruleset = [
    {
      permission: "todowrite",
      pattern: "*",
      action: "deny",
    },
    {
      permission: "todoread",
      pattern: "*",
      action: "deny",
    },
    ...(input.hasTaskPermission
      ? []
      : [{ permission: "task", pattern: "*", action: "deny" } satisfies PermissionNext.Rule]),
    ...(input.gitLabReviewBoundary
      ? []
      : input.primaryTools.map((permission) => ({
          permission,
          pattern: "*",
          action: "allow" as const,
        }))),
  ]
  return input.gitLabReviewBoundary
    ? PermissionNext.merge(taskRules, input.agentPermission)
    : taskRules
}

async function gitLabReviewSpecialistRuntime(input: {
  owner: Session.Info
  agent: { name: string; model?: { providerID: string; modelID: string } }
  permission: PermissionNext.Ruleset
}) {
  const ownerProfile = await SessionRuntimeProfile.read(input.owner)
  if (
    !ownerProfile
    || ownerProfile.id !== input.owner.runtime?.profileSnapshotId
    || ownerProfile.sessionId !== input.owner.id
    || ownerProfile.agent.name !== "platform.gitlab.pm-coordinator"
  ) {
    throw new Error("gitlab_review_task_owner_provenance_invalid")
  }
  const model = input.agent.model ?? input.owner.runtime?.currentModel ?? ownerProfile.defaultModel
  const ownerMarker = gitLabReviewSpecialistOwnerMarker(input.owner.id)
  const profile: SessionProfileSnapshot = {
    id: ulid(),
    createdAt: Date.now(),
    source: "new-session",
    sourceTemplateIds: gitLabReviewSpecialistTemplateIds(input.owner.id),
    agent: {
      name: input.agent.name,
      source: "internal-runtime",
    },
    defaultModel: {
      providerID: model.providerID,
      modelID: model.modelID,
      source: "default-user-template",
    },
    context: { blocks: [] },
    resources: RuntimeResourceResolver.emptyResources(),
    permissions: {
      rules: { specialist: input.permission },
      source: [GITLAB_REVIEW_SPECIALIST_TEMPLATE, ownerMarker],
      mergeMode: "strict",
    },
    sessionPermissionGrants: [],
    orchestration: { mode: "single" },
  }
  return {
    profile,
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
    },
  }
}

async function isOwnedGitLabReviewSpecialistSession(input: {
  session: Session.Info
  owner: Session.Info
  agentName: string
  permission: PermissionNext.Ruleset
}) {
  if (
    input.session.parentID !== input.owner.id
    || input.session.projectID !== input.owner.projectID
    || input.session.directory !== input.owner.directory
    || !sameClient(input.session.client, input.owner.client)
    || input.session.runtime?.agent !== input.agentName
    || !sameRules(input.session.permission, input.permission)
  ) return false

  const profile = await SessionRuntimeProfile.read(input.session)
  const ownerMarker = gitLabReviewSpecialistOwnerMarker(input.owner.id)
  if (
    !profile
    || profile.id !== input.session.runtime.profileSnapshotId
    || profile.sessionId !== input.session.id
    || profile.agent.name !== input.agentName
    || profile.permissions.mergeMode !== "strict"
    || !sameStrings(profile.sourceTemplateIds, gitLabReviewSpecialistTemplateIds(input.owner.id))
    || !sameStrings(profile.permissions.source, [GITLAB_REVIEW_SPECIALIST_TEMPLATE, ownerMarker])
    || !sameRules(profile.permissions.rules.specialist, input.permission)
    || profile.context.blocks.length !== 0
    || (profile.sessionPermissionGrants?.length ?? 0) !== 0
    || Object.keys(profile.resources.builtinTools).length !== 0
    || profile.resources.mcp.servers.length !== 0
    || Object.keys(profile.resources.mcp.tools ?? {}).length !== 0
    || profile.resources.skills.skills.length !== 0
  ) return false

  return true
}

function gitLabReviewSpecialistOwnerMarker(sessionID: string) {
  return `gitlab-review-owner:${sessionID}`
}

function gitLabReviewSpecialistTemplateIds(ownerSessionID: string) {
  return [
    GITLAB_REVIEW_SPECIALIST_TEMPLATE,
    gitLabReviewSpecialistOwnerMarker(ownerSessionID),
    RuntimeResourceResolver.resourceTemplateId(),
  ]
}

function sameClient(left: Session.Client | undefined, right: Session.Client | undefined) {
  return left?.source === right?.source
    && left?.platform === right?.platform
    && left?.mode === right?.mode
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameRules(left: unknown, right: PermissionNext.Ruleset) {
  if (!Array.isArray(left) || left.length !== right.length) return false
  return left.every((value, index) => {
    const expected = right[index]
    return Boolean(
      value
      && typeof value === "object"
      && (value as PermissionNext.Rule).permission === expected?.permission
      && (value as PermissionNext.Rule).pattern === expected.pattern
      && (value as PermissionNext.Rule).action === expected.action,
    )
  })
}
