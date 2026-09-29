import { afterEach, beforeEach, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Identifier } from "../../src/id/id"
import { Server } from "../../src/server/server"
import { RunLease } from "../../src/session/run-lease"
import { tmpdir } from "../fixture/fixture"

let previous: NodeJS.ProcessEnv
beforeEach(() => {
  previous = { ...process.env }
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
})
async function fixture(fn: (session: Session.Info) => Promise<void>) {
  await using tmp = await tmpdir({ config: { model: "test/model" } })
  process.env.OPENCODE_CONFIG = tmp.path + "/opencode.json"
  process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true"
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = "true"
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await fn(await Session.create({}))
    },
  })
}

test("the same accepted request replays without duplicate parts, including after instance reload", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      model: { providerID: "test", modelID: "model" },
      parts: [{ type: "text" as const, text: "retry me" }],
    }
    await SessionPrompt.promptAsync(input)
    expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
    const messages = await Session.messages({ sessionID: session.id })
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toHaveLength(1)
    await Instance.dispose()
    await Instance.provide({
      directory: session.directory,
      fn: async () => {
        expect((await SessionPrompt.promptAsync(input))?.replayed).toBe(true)
        expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
      },
    })
  })
})

test("the same ID with different content or another session is rejected", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      parts: [{ type: "text" as const, text: "original" }],
    }
    await SessionPrompt.promptAsync(input)
    await expect(
      SessionPrompt.promptAsync({ ...input, parts: [{ type: "text", text: "changed" }] }),
    ).rejects.toMatchObject({ status: 409 })
    const other = await Session.create({})
    await expect(SessionPrompt.promptAsync({ ...input, sessionID: other.id })).rejects.toMatchObject({ status: 409 })
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
    expect(await Session.messages({ sessionID: other.id })).toHaveLength(0)
  })
})

test("concurrent submissions cannot create duplicate parts", async () => {
  await fixture(async (session) => {
    const input = {
      sessionID: session.id,
      messageID: Identifier.ascending("message"),
      noReply: true,
      parts: [{ type: "text" as const, text: "once" }],
    }
    const results = await Promise.allSettled([SessionPrompt.promptAsync(input), SessionPrompt.promptAsync(input)])
    expect(results.some((result) => result.status === "fulfilled")).toBe(true)
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
  })
})

test("controller replay returns the original turn identity even while another turn holds the lease", async () => {
  await fixture(async (session) => {
    const send = (body: unknown) =>
      Server.App().request(`/nine1bot/agent/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-directory": session.directory },
        body: JSON.stringify(body),
      })
    const body = { messageID: Identifier.ascending("message"), noReply: true, parts: [{ type: "text", text: "once" }] }
    const first = await send(body)
    expect(first.status).toBe(202)
    const original = await first.json()
    const lease = RunLease.reserve(session.id)
    try {
      const second = await send(body)
      expect(second.status).toBe(202)
      expect((await second.json()).turnSnapshotId).toBe(original.turnSnapshotId)
      expect(RunLease.current(session.id)?.id).toBe(lease.id)
    } finally {
      RunLease.release(session.id, lease.id)
    }
    expect((await Session.messages({ sessionID: session.id }))[0].parts).toHaveLength(1)
  })
})
