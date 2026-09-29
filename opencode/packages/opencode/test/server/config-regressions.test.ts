import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"

let original: NodeJS.ProcessEnv
beforeEach(() => {
  original = { ...process.env }
})
afterEach(async () => {
  await Instance.disposeAll()
  for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k]
  Object.assign(process.env, original)
})
const schema = "https://opencode.ai/config.json"
async function setup(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nine1bot-backend-audit-"))
  const directory = path.join(root, "project")
  await mkdir(directory)
  const other = path.join(root, "other")
  await mkdir(other)
  const runtime = path.join(root, "generated-runtime.json"),
    persistent = path.join(root, "nine1bot.config.jsonc")
  const config = {
    $schema: schema,
    model: "audit/chat",
    provider: {
      audit: {
        npm: "@ai-sdk/openai-compatible",
        name: "Audit",
        options: { apiKey: "synthetic-only", baseURL: "http://127.0.0.1:1" },
        models: { chat: { name: "Chat" }, next: { name: "Next" } },
      },
    },
    ...extra,
  }
  await writeFile(runtime, JSON.stringify(config))
  await writeFile(persistent, "{}")
  Object.assign(process.env, {
    OPENCODE_CONFIG: runtime,
    NINE1BOT_CONFIG_PATH: persistent,
    NINE1BOT_AUTH_PATH: path.join(root, "auth.json"),
    OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL: "true",
  })
  return { root, directory, other, runtime, persistent, config }
}
function request(directory: string, url: string, method = "GET", body?: unknown) {
  return Server.App().request(url, {
    method,
    headers: { "Content-Type": "application/json", "x-opencode-directory": directory },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const inDir = <T>(directory: string, fn: () => T) => Instance.provide({ directory, fn })

describe("configuration persistence and invalidation", () => {
  test("PATCH writes the real source when runtime and project paths differ", async () => {
    const f = await setup()
    const response = await request(f.directory, "/config", "PATCH", { model: "audit/next" })
    const read = await request(f.directory, "/config")
    const actual = await read.json()
    expect(response.status).toBe(200)
    expect(actual.model).toBe("audit/next")
    expect(JSON.parse(await readFile(f.persistent, "utf8")).model).toBe("audit/next")
  })
  test("concurrent config saves preserve both acknowledged fields", async () => {
    const f = await setup()
    await request(f.directory, "/config")
    const responses = await Promise.all([
      request(f.directory, "/config/nine1bot", "PATCH", { model: "audit/next" }),
      request(f.directory, "/config/nine1bot", "PATCH", { small_model: "audit/chat" }),
    ])
    const text = await readFile(f.persistent, "utf8")
    let actual: any
    try {
      actual = JSON.parse(text)
    } catch {
      actual = { invalidJSON: true }
    }
    expect(responses.every((r) => r.status === 200)).toBe(true)
    expect(actual.model === "audit/next" && actual.small_model === "audit/chat").toBe(true)
  })
  test("concurrent credential saves retain every provider", async () => {
    const f = await setup()
    await Auth.set("initial", { type: "api", key: "synthetic-only" })
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => Auth.set("test-" + i, { type: "api", key: "synthetic-only" })),
    )
    const saved = Object.keys(await Auth.all())
    expect(saved.length).toBe(9)
  })
  test("custom provider writes preserve project scope", async () => {
    const f = await setup()
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "false"
    await writeFile(
      path.join(f.directory, "opencode.json"),
      JSON.stringify({
        $schema: schema,
        provider: {
          "project-only": {
            name: "Project Only",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://127.0.0.1:2" },
            models: { local: { name: "Local" } },
          },
        },
      }),
    )
    const before = await inDir(f.other, () => Config.get())
    expect(before.provider?.["project-only"]).toBeUndefined()
    const saved = await request(f.directory, "/config/nine1bot/custom-providers/global-audit", "PUT", {
      name: "Global",
      protocol: "openai",
      baseURL: "http://127.0.0.1:3",
      models: [{ id: "chat" }],
    })
    const after = await inDir(f.other, () => Config.get())
    expect(saved.status).toBe(200)
    expect(after.provider?.["project-only"]).toBeUndefined()
    expect(after.provider?.["global-audit"]).toBeDefined()
    expect(after.provider?.audit).toBeDefined()
  })
  test("invalid config is rejected before either file is modified", async () => {
    const f = await setup()
    const save = await request(f.directory, "/config/nine1bot", "PATCH", { model: 42 })
    const read = await request(f.directory, "/config")
    expect(save.status).toBe(400)
    expect(read.status).toBe(200)
    expect(JSON.parse(await readFile(f.persistent, "utf8"))).toEqual({})
  })
  test("agent prompt and permission cache follows configuration changes", async () => {
    const f = await setup({ agent: { build: { prompt: "before", permission: { bash: "allow" } } } })
    const before = await inDir(f.directory, () => Agent.get("build"))
    expect(before?.prompt).toBe("before")
    const save = await request(f.directory, "/config/nine1bot", "PATCH", {
      agent: { build: { prompt: "after", permission: { bash: "deny" } } },
    })
    const config = await inDir(f.directory, () => Config.get())
    const after = await inDir(f.directory, () => Agent.get("build"))
    expect(config.agent?.build?.prompt).toBe("after")
    expect(after?.prompt).toBe("after")
    expect(after?.permission.find((x) => x.permission === "bash")?.action).toBe("deny")
  })
})
