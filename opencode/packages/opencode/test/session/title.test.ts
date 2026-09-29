import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { SessionTitle } from "../../src/session/title"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { Provider } from "../../src/provider/provider"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

afterEach(() => mock.restore())
function model(id: string) {
  return {
    id,
    providerID: "test",
    api: { npm: "@ai-sdk/openai-compatible" },
    capabilities: { attachment: false },
  } as Provider.Model
}
function output(text: string | Promise<string>) {
  return { text: Promise.resolve(text) } as Awaited<ReturnType<typeof LLM.stream>>
}
function message(sessionID: string, text: string): MessageV2.WithParts {
  const id = Identifier.ascending("message")
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: "test", modelID: "chat" },
    },
    parts: [{ id: Identifier.ascending("part"), sessionID, messageID: id, type: "text", text }],
  }
}
async function fixture(fn: (input: Parameters<typeof SessionTitle.ensure>[0]) => Promise<void>) {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session: Session.Info = {
        id: Identifier.ascending("session"),
        slug: "title-test",
        directory: tmp.path,
        projectID: Instance.project.id,
        version: "test",
        title: "New session - 2026-09-29T00:00:00.000Z",
        time: { created: 1, updated: 1 },
      }
      await Storage.write(["session", session.projectID, session.id], session)
      spyOn(Agent, "get").mockResolvedValue({
        name: "title",
        mode: "primary",
        native: true,
        options: {},
        permission: [],
      })
      spyOn(Provider, "getSmallModel").mockResolvedValue(model("small"))
      spyOn(Provider, "getModel").mockImplementation(async (_, id) => model(id))
      await fn({ session, history: [message(session.id, "修复聊天卡顿")], providerID: "test", modelID: "chat" })
    },
  })
}

describe("session title recovery", () => {
  test("falls back from an unavailable small model and publishes the saved title without touching recency", async () => {
    await fixture(async (input) => {
      const stream = spyOn(LLM, "stream").mockImplementation(async ({ model }) => {
        if (model.id === "small") throw new Error("model access denied")
        return output("优化聊天体验")
      })
      const titles: string[] = []
      const unsubscribe = Bus.subscribe(Session.Event.Updated, (event) => {
        titles.push(event.properties.info.title)
      })
      try {
        await SessionTitle.ensure(input)
      } finally {
        unsubscribe()
      }
      const saved = await Session.get(input.session.id)
      expect(saved.title).toBe("优化聊天体验")
      expect(saved.time.updated).toBe(1)
      expect(titles).toContain("优化聊天体验")
      expect(stream.mock.calls.map(([input]) => input.model.id)).toEqual(["small", "chat"])
    })
  })
  test("invalid small-model configuration still allows the current model to name the session", async () => {
    await fixture(async (input) => {
      spyOn(Provider, "getSmallModel").mockRejectedValue(new Error("configured model not found"))
      const stream = spyOn(LLM, "stream").mockResolvedValue(output("聊天修复"))
      await SessionTitle.ensure(input)
      expect((await Session.get(input.session.id)).title).toBe("聊天修复")
      expect(stream.mock.calls[0][0].model.id).toBe("chat")
    })
  })
  test("retries on a later user turn using the original request", async () => {
    await fixture(async (input) => {
      const stream = spyOn(LLM, "stream").mockRejectedValue(new Error("temporary failure"))
      await SessionTitle.ensure(input)
      expect((await Session.get(input.session.id)).title).toBe(input.session.title)
      input.history.push(message(input.session.id, "第二个问题"))
      stream.mockImplementation(async ({ messages }) => {
        expect(JSON.stringify(messages)).toContain("修复聊天卡顿")
        expect(JSON.stringify(messages)).not.toContain("第二个问题")
        return output("恢复后的标题")
      })
      await SessionTitle.ensure(input)
      expect((await Session.get(input.session.id)).title).toBe("恢复后的标题")
      expect(stream).toHaveBeenCalledTimes(3)
    })
  })
  test("deduplicates requests and preserves a manual rename while generation is pending", async () => {
    await fixture(async (input) => {
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<string>()
      const stream = spyOn(LLM, "stream").mockImplementation(async () => {
        started.resolve()
        return output(response.promise)
      })
      const first = SessionTitle.ensure(input)
      await started.promise
      const second = SessionTitle.ensure(input)
      expect(second).toBe(first)
      await Session.update(input.session.id, (draft) => {
        draft.title = "我的手动标题"
      })
      response.resolve("自动生成标题")
      await Promise.all([first, second])
      expect((await Session.get(input.session.id)).title).toBe("我的手动标题")
      await SessionTitle.ensure(input)
      expect(stream).toHaveBeenCalledTimes(1)
    })
  })
  test("treats empty output as failure and cleans reasoning from the fallback title", async () => {
    await fixture(async (input) => {
      spyOn(LLM, "stream").mockImplementation(async ({ model }) =>
        output(model.id === "small" ? "<think>thinking</think>\n " : "<think>thinking</think>\n修复标题\nextra"),
      )
      await SessionTitle.ensure(input)
      expect((await Session.get(input.session.id)).title).toBe("修复标题")
    })
  })
  test("does not request the same failed model twice", async () => {
    await fixture(async (input) => {
      spyOn(Provider, "getSmallModel").mockResolvedValue(model("chat"))
      const stream = spyOn(LLM, "stream").mockRejectedValue(new Error("unavailable"))
      await SessionTitle.ensure(input)
      expect(stream).toHaveBeenCalledTimes(1)
    })
  })
  test("times out a hung stream, aborts it and ignores its late result", async () => {
    await fixture(async (input) => {
      const response = Promise.withResolvers<string>()
      let signal: AbortSignal | undefined
      spyOn(LLM, "stream").mockImplementation(async (request) => {
        if (request.model.id === "small") {
          signal = request.abort
          return output(response.promise)
        }
        return output("超时后恢复")
      })
      await SessionTitle.ensure(input)
      expect(signal?.aborted).toBe(true)
      expect((await Session.get(input.session.id)).title).toBe("超时后恢复")
      response.resolve("迟到的标题")
      await Promise.resolve()
      expect((await Session.get(input.session.id)).title).toBe("超时后恢复")
    })
  }, 40_000)
})
