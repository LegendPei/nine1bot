import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { checkAndReloadMcpConfig } from "../../src/mcp/hot-reload"
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
async function setup() {
  const tmp = await tmpdir()
  const source = path.join(tmp.path, "nine1bot.jsonc"),
    runtime = path.join(tmp.path, "runtime.json")
  const config = { mcp: { existing: { type: "local", command: ["unused"], enabled: false } } }
  await fs.writeFile(source, JSON.stringify(config))
  await fs.writeFile(runtime, JSON.stringify(config))
  Object.assign(process.env, {
    NINE1BOT_CONFIG_PATH: source,
    OPENCODE_CONFIG: runtime,
    OPENCODE_DISABLE_GLOBAL_CONFIG: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL: "true",
  })
  return { directory: tmp.path, source, runtime, config }
}
const request = (directory: string, url: string, method = "GET", body?: unknown) =>
  Server.App().request(url, {
    method,
    headers: { "x-opencode-directory": directory, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

test("MCP create/delete persist and remain correct after instance restart", async () => {
  const f = await setup()
  const added = await request(f.directory, "/mcp", "POST", {
    name: "added",
    config: { type: "remote", url: "https://example.invalid/mcp", enabled: false },
  })
  expect(added.status).toBe(200)
  expect((await (await request(f.directory, "/mcp")).json()).added).toBeDefined()
  const removed = await request(f.directory, "/mcp/existing", "DELETE")
  expect(removed.status).toBe(200)
  expect((await (await request(f.directory, "/mcp")).json()).existing).toBeUndefined()
  await Instance.disposeAll()
  const restarted = await (await request(f.directory, "/mcp")).json()
  expect(restarted.added).toBeDefined()
  expect(restarted.existing).toBeUndefined()
  expect(JSON.parse(await fs.readFile(f.source, "utf8")).mcp.existing).toEqual({ enabled: false })
})

test("URLs/comments and malformed edits cannot remove unchanged MCPs", async () => {
  const f = await setup()
  await request(f.directory, "/mcp")
  await fs.writeFile(
    f.source,
    "// comment\n" +
      JSON.stringify({ ...f.config, customProviders: { demo: { baseURL: "https://example.invalid/v1" } } }),
  )
  await Instance.provide({ directory: f.directory, fn: () => checkAndReloadMcpConfig(true) })
  expect((await (await request(f.directory, "/mcp")).json()).existing).toBeDefined()
  const runtimeBefore = await fs.readFile(f.runtime, "utf8")
  await fs.writeFile(f.source, '{"mcp":')
  await Instance.provide({ directory: f.directory, fn: () => checkAndReloadMcpConfig(true) })
  expect(await fs.readFile(f.runtime, "utf8")).toBe(runtimeBefore)
  expect((await (await request(f.directory, "/mcp")).json()).existing).toBeDefined()
})

test("valid external MCP edits refresh the runtime and list", async () => {
  const f = await setup()
  await request(f.directory, "/mcp")
  await fs.writeFile(
    f.source,
    JSON.stringify({ mcp: { replacement: { type: "local", command: ["unused"], enabled: false } } }),
  )
  await Instance.provide({ directory: f.directory, fn: () => checkAndReloadMcpConfig(true) })
  const list = await (await request(f.directory, "/mcp")).json()
  expect(Object.keys(list)).toEqual(["replacement"])
})
