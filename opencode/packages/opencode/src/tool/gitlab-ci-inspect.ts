import z from "zod"
import { Tool } from "./tool"
import {
  inspectGitLabCiForSession,
  type GitLabCiSessionRequest,
  type GitLabCiToolOutput,
} from "../../../../../packages/nine1bot/src/review/gitlab-ci-inspector"
import { readPlatformManagerConfig } from "../../../../../packages/nine1bot/src/platform/config-store"
import { FilePlatformSecretStore } from "../../../../../packages/nine1bot/src/platform/secrets"

type GitLabCiInspectDependencies = {
  inspect: (sessionId: string, request: GitLabCiSessionRequest, signal: AbortSignal) => Promise<GitLabCiToolOutput>
}

const parameters = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("read_job_log"),
    jobId: z.number().int().positive(),
  }).strict(),
])

export function createGitLabCiInspectTool(dependencies: GitLabCiInspectDependencies): Tool.Info<typeof parameters> {
  return Tool.define(
    "gitlab_ci_inspect",
    {
      description: [
        "Inspect CI for the GitLab merge request bound to the current review session.",
        "Call list first to see the HEAD pipeline and bounded job list, then read selected job logs only when needed.",
        "Logs are available for any job status and are bounded and sanitized by the server.",
      ].join(" "),
      parameters,
      async execute(args, context) {
        const result = await dependencies.inspect(context.sessionID, args, context.abort)
        return {
          title: "GitLab CI inspection",
          output: JSON.stringify(result),
          metadata: {
            truncated: result.ok ? result.truncated : false,
          },
        }
      },
    },
    { requireExplicitEnable: true },
  )
}

export const GitLabCiInspectTool = createGitLabCiInspectTool({
  async inspect(sessionId, request, signal) {
    try {
      return await inspectGitLabCiForSession({
        sessionId,
        request,
        platforms: await readPlatformManagerConfig(),
        secrets: new FilePlatformSecretStore(process.env.NINE1BOT_PLATFORM_SECRETS_PATH),
        signal,
      })
    } catch (error) {
      return {
        ok: false,
        action: request.action,
        diagnostic: `gitlab_ci_tool_unavailable:${error instanceof Error ? error.name : "unknown"}`,
      }
    }
  },
})
