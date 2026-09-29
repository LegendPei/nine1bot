import path from "node:path"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Global } from "../global"
import { JsonFile } from "../util/json-file"
import { Log } from "../util/log"

const log = Log.create({ service: "mcp-hot-reload" })
const ttl = 30_000
const state = Instance.state(
  () => ({
    lastCheck: 0,
    source: undefined as Record<string, Config.Mcp | { enabled: boolean }> | undefined,
    applied: {} as Record<string, string>,
    checking: undefined as Promise<void> | undefined,
    timer: undefined as ReturnType<typeof setInterval> | undefined,
  }),
  async (value) => {
    if (value.timer) clearInterval(value.timer)
  },
)

export function startMcpConfigWatcher(config: Config.Info["mcp"] = {}) {
  const current = state()
  current.applied = Object.fromEntries(
    Object.entries(config)
      .filter(([, entry]) => "type" in entry)
      .map(([name, entry]) => [name, JSON.stringify(entry)]),
  )
  if (current.timer || !process.env.NINE1BOT_CONFIG_PATH) return
  current.timer = setInterval(() => {
    void checkAndReloadMcpConfig()
  }, ttl)
  current.timer.unref?.()
}

export function stopMcpConfigWatcher() {
  const current = state()
  if (current.timer) clearInterval(current.timer)
  current.timer = undefined
}

async function readSources() {
  const projectPath = process.env.NINE1BOT_CONFIG_PATH
  if (!projectPath) return undefined
  const project = await JsonFile.read(projectPath)
  if (!project.existed) throw new Error(`MCP configuration file is missing: ${projectPath}`)
  const globalPath = path.join(Global.Path.home, ".config", "nine1bot", "config.jsonc")
  const global =
    project.data.isolation?.disableGlobalConfig || path.resolve(globalPath) === path.resolve(projectPath)
      ? {}
      : (await JsonFile.read(globalPath)).data
  const { inheritOpencode, inheritClaudeCode, ...servers } = { ...global.mcp, ...project.data.mcp }
  // Parse failure is an error, never an empty configuration/removal command.
  return Config.Info.shape.mcp.parse(servers) ?? {}
}

export async function checkAndReloadMcpConfig(force = false): Promise<void> {
  const current = state()
  if (current.checking) {
    await current.checking
    if (force) return checkAndReloadMcpConfig(true)
    return
  }
  if (!force && Date.now() - current.lastCheck < ttl) return
  current.lastCheck = Date.now()
  current.checking = reload()
    .catch((error) => {
      log.error("Failed to reload MCP config; preserving existing connections", { error })
    })
    .finally(() => {
      current.checking = undefined
    })
  return current.checking
}

async function reload() {
  const current = state()
  const source = await readSources()
  const runtime = process.env.OPENCODE_CONFIG
  if (source && current.source && JSON.stringify(source) !== JSON.stringify(current.source) && runtime) {
    await JsonFile.update(runtime, (draft) => {
      draft.mcp ??= {}
      JsonFile.applyDiff(draft.mcp, current.source!, source)
      Config.Info.parse(draft)
    })
    Config.refreshAll()
  }
  if (source) current.source = source

  const { MCP } = await import("./index")
  await MCP.clients() // Initial connection setup also seeds applied config hashes.
  const config = (await Config.get()).mcp ?? {}
  for (const name of Object.keys(current.applied)) {
    if (config[name] && "type" in config[name]) continue
    await MCP.remove(name)
    delete current.applied[name]
  }
  for (const [name, entry] of Object.entries(config)) {
    if (!("type" in entry)) continue
    const hash = JSON.stringify(entry)
    if (current.applied[name] === hash) continue
    await MCP.add(name, entry)
    current.applied[name] = hash
  }
}
