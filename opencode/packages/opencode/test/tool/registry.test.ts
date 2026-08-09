import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { toolSelectionAllows } from "../../src/tool/selection"
import { clearBridgeServer, setBridgeServer } from "../../src/browser/bridge"

describe("tool.registry", () => {
  afterEach(() => {
    clearBridgeServer()
  })

  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("hides browser tools until the bridge is configured", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        clearBridgeServer()
        const defaultIds = await ToolRegistry.ids()
        expect(defaultIds).not.toContain("browser_status")
        expect(defaultIds).toContain("gitlab_ci_inspect")

        setBridgeServer({} as any)
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("browser_status")
        expect(ids).toContain("browser_locate")

        clearBridgeServer()
        expect(await ToolRegistry.ids()).not.toContain("browser_status")
      },
    })
  })

  test("requires explicit opt-in for dedicated tools and honors deny-by-default selection", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
        const gitlab = tools.find((tool) => tool.id === "gitlab_ci_inspect")
        const read = tools.find((tool) => tool.id === "read")

        expect(gitlab?.requireExplicitEnable).toBe(true)
        expect(gitlab && toolSelectionAllows(gitlab, undefined)).toBe(false)
        expect(gitlab && toolSelectionAllows(gitlab, { gitlab_ci_inspect: true })).toBe(true)
        expect(read && toolSelectionAllows(read, { "*": false })).toBe(false)
        expect(read && toolSelectionAllows(read, { "*": false, read: true })).toBe(true)
      },
    })
  })
})
