import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { RunLease } from "../../src/session/run-lease"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

let environment: NodeJS.ProcessEnv
beforeEach(() => {
  environment = { ...process.env }
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
  Object.assign(process.env, environment)
})
async function setup(git = false) {
  const tmp = await tmpdir({ git })
  const nested = path.join(tmp.path, "nested")
  await fs.mkdir(nested)
  const runtime = path.join(tmp.path, "runtime.json")
  await fs.writeFile(runtime, JSON.stringify({ model: "test/model" }))
  Object.assign(process.env, {
    OPENCODE_CONFIG: runtime,
    OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL: "true",
  })
  return { directory: tmp.path, nested }
}
const inDir = <T>(directory: string, fn: () => T) => Instance.provide({ directory, fn })
function request(directory: string, url: string, method = "GET", body?: unknown) {
  return Server.App().request(url, {
    method,
    headers: { "x-opencode-directory": directory, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test("aliases share a canonical instance, busy status and cancellation", async () => {
  const f = await setup()
  const session = await inDir(f.directory, () => Session.create({}))
  const lease = await inDir(f.directory, () => RunLease.reserve(session.id))
  try {
    const alternate = f.directory + "/."
    expect(await inDir(alternate, () => Instance.directory)).toBe(f.directory)
    expect(await inDir(alternate, () => SessionStatus.get(session.id).type)).toBe("busy")
    const sent = await request(alternate, `/nine1bot/agent/sessions/${session.id}/messages`, "POST", {
      noReply: true,
      parts: [{ type: "text", text: "must not be accepted" }],
    })
    expect(sent.status).toBe(409)
    const abort = await request(alternate, `/session/${session.id}/abort`, "POST")
    expect(await abort.json()).toBe(true)
    expect(lease.controller.signal.aborted).toBe(true)
    expect(() => RunLease.reserve(session.id)).toThrow()
  } finally {
    await inDir(f.directory, () => RunLease.release(session.id, lease.id))
  }
})

test("different subdirectories in one Git project cannot acquire two leases", async () => {
  const f = await setup(true)
  const session = await inDir(f.directory, () => Session.create({}))
  const lease = await inDir(f.directory, () => RunLease.reserve(session.id))
  try {
    await inDir(f.nested, async () => {
      expect((await Session.get(session.id)).id).toBe(session.id)
      expect(() => RunLease.reserve(session.id)).toThrow()
      expect(SessionStatus.list()[session.id].type).toBe("busy")
    })
    const abort = await request(f.nested, `/session/${session.id}/abort`, "POST")
    expect(await abort.json()).toBe(true)
    expect(lease.controller.signal.aborted).toBe(true)
  } finally {
    await inDir(f.directory, () => RunLease.release(session.id, lease.id))
  }
})

test("cross-project directory change is rejected without making the session unreachable", async () => {
  const f = await setup()
  const session = await inDir(f.directory, () => Session.create({}))
  const response = await request(f.directory, `/session/${session.id}`, "PATCH", { directory: f.nested })
  expect(response.status).toBe(400)
  expect((await response.json()).error).toContain("新建会话")
  expect((await (await request(f.directory, `/session/${session.id}`)).json()).directory).toBe(f.directory)
})

test("same-project directory change succeeds only while idle and empty", async () => {
  const f = await setup(true)
  const session = await inDir(f.directory, () => Session.create({}))
  const lease = await inDir(f.directory, () => RunLease.reserve(session.id))
  try {
    expect((await request(f.directory, `/session/${session.id}`, "PATCH", { directory: f.nested })).status).toBe(409)
  } finally {
    await inDir(f.directory, () => RunLease.release(session.id, lease.id))
  }
  expect((await request(f.directory, `/session/${session.id}`, "PATCH", { directory: f.nested })).status).toBe(200)
  expect((await (await request(f.nested, `/session/${session.id}`)).json()).directory).toBe(f.nested)
})

test("busy deletion is rejected and idle deletion propagates missing-session errors", async () => {
  const f = await setup()
  const session = await inDir(f.directory, () => Session.create({}))
  const lease = await inDir(f.directory, () => RunLease.reserve(session.id))
  try {
    expect((await request(f.directory, `/session/${session.id}`, "DELETE")).status).toBe(409)
    expect((await request(f.directory, `/session/${session.id}`)).status).toBe(200)
  } finally {
    await inDir(f.directory, () => RunLease.release(session.id, lease.id))
  }
  expect((await request(f.directory, `/session/${session.id}`, "DELETE")).status).toBe(200)
  expect((await request(f.directory, `/session/${session.id}`, "DELETE")).status).toBe(404)
})

test("creation uses the requested directory's project even when the header names another project", async () => {
  const f = await setup()
  const response = await request(f.directory, "/nine1bot/agent/sessions", "POST", { directory: f.nested })
  expect(response.status).toBe(200)
  const created = await response.json()
  expect((await request(f.nested, `/session/${created.sessionId}`)).status).toBe(200)
  expect((await request(f.directory, `/session/${created.sessionId}`)).status).toBe(404)
})

test("a session event stream opened from another project subdirectory receives the owner's updates", async () => {
  const f = await setup(true)
  const session = await inDir(f.directory, () => Session.create({}))
  const controller = new AbortController()
  const response = await Server.App().request(`/nine1bot/agent/sessions/${session.id}/events`, {
    headers: { "x-opencode-directory": f.nested }, signal: controller.signal,
  })
  const reader = response.body!.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await reader.read()
    await new Promise(resolve => setTimeout(resolve, 0))
    await inDir(f.directory, () => Session.update(session.id, draft => { draft.title = "owner-title-update" }))
    const event = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owner event not delivered")), 1500) }),
    ])
    expect(new TextDecoder().decode(event.value)).toContain("owner-title-update")
  } finally {
    clearTimeout(timer)
    controller.abort()
    await reader.cancel().catch(() => {})
  }
})
