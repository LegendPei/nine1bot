import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Session } from "."
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"

export namespace SessionTitle {
  const log = Log.create({ service: "session.title" })
  const pending = Instance.state(() => new Map<string, Promise<void>>())
  const requestTimeout = 30_000

  type Input = {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: string
    modelID: string
  }

  export function ensure(input: Input): Promise<void> {
    if (input.session.parentID || !Session.isDefaultTitle(input.session.title)) return Promise.resolve()
    const requests = pending()
    const existing = requests.get(input.session.id)
    if (existing) return existing
    const request = generate(input).finally(() => requests.delete(input.session.id))
    requests.set(input.session.id, request)
    return request
  }

  async function generate(input: Input) {
    // Re-read before starting and before saving: the caller's snapshot may be stale.
    const session = await Session.get(input.session.id)
    if (!Session.isDefaultTitle(session.title)) return
    const firstUserIndex = input.history.findIndex(
      (message) =>
        message.info.role === "user" && !message.parts.every((part) => "synthetic" in part && part.synthetic),
    )
    if (firstUserIndex === -1) return
    // A failed first attempt can recover on a later turn, still using the original request.
    const context = input.history.slice(0, firstUserIndex + 1)
    const user = context[firstUserIndex]
    const subtasks = user.parts.filter((part): part is MessageV2.SubtaskPart => part.type === "subtask")
    const subtaskOnly = subtasks.length > 0 && subtasks.length === user.parts.length
    const agent = await Agent.get("title")
    if (!agent) return

    const candidates = [
      () =>
        agent.model
          ? Provider.getModel(agent.model.providerID, agent.model.modelID)
          : Provider.getSmallModel(input.providerID),
      () => Provider.getModel(input.providerID, input.modelID),
    ]
    const tried = new Set<string>()
    for (const resolve of candidates) {
      let model: Provider.Model | undefined
      try {
        model = await resolve()
        if (!model) continue
        const key = `${model.providerID}/${model.id}`
        if (tried.has(key)) continue
        tried.add(key)
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const title = await Promise.race([
            (async () => {
              const result = await LLM.stream({
                agent,
                user: user.info as MessageV2.User,
                system: [],
                small: true,
                tools: {},
                model,
                abort: controller.signal,
                sessionID: session.id,
                retries: 1,
                messages: [
                  { role: "user", content: "Generate a title for this conversation:\n" },
                  ...(subtaskOnly
                    ? [{ role: "user" as const, content: subtasks.map((part) => part.prompt).join("\n") }]
                    : MessageV2.toModelMessages(context, model)),
                ],
              })
              const text = await result.text
              const cleaned = text
                .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
                .split("\n")
                .map((line) => line.trim())
                .find(Boolean)
              if (!cleaned) throw new Error("Title model returned an empty title")
              return cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error("Title generation timed out")
                reject(error)
                controller.abort(error)
              }, requestTimeout)
            }),
          ])
          await Session.update(
            session.id,
            (draft) => {
              if (Session.isDefaultTitle(draft.title)) draft.title = title
            },
            { touch: false },
          )
          return
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        log.warn("title attempt failed", {
          sessionID: session.id,
          providerID: model?.providerID,
          modelID: model?.id,
          error,
        })
      }
    }
  }
}
