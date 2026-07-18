import { describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"

describe("MCP prompt tool resolution", () => {
  test("isolates a stalled client while returning healthy tools", async () => {
    const failures: string[] = []
    const starts: string[] = []
    const startedAt = Date.now()
    const resolution = MCP._testing.resolveToolSources(
      [
        {
          server: "stalled",
          timeoutMs: 20,
          client: {
            listTools: () => {
              starts.push("stalled")
              return new Promise(() => {})
            },
          },
        },
        {
          server: "healthy",
          timeoutMs: 20,
          client: {
            async listTools() {
              starts.push("healthy")
              return {
                tools: [
                  {
                    name: "healthy-tool",
                    description: "healthy",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            },
          },
        },
      ],
      async (failure) => {
        failures.push(failure.server)
      },
    )
    await Promise.resolve()
    expect(starts).toEqual(["stalled", "healthy"])
    const result = await resolution

    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(result).toEqual([
      {
        server: "healthy",
        cached: false,
        tools: [
          {
            name: "healthy-tool",
            description: "healthy",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ])
    expect(failures).toEqual(["stalled"])
  })

  test("uses a valid cache without calling the client again", async () => {
    let calls = 0
    const result = await MCP._testing.resolveToolSources([
      {
        server: "cached",
        timeoutMs: 20,
        cached: [
          {
            name: "cached-tool",
            description: "cached",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        client: {
          async listTools() {
            calls++
            return { tools: [] }
          },
        },
      },
    ])

    expect(calls).toBe(0)
    expect(result[0]?.cached).toBe(true)
    expect(result[0]?.tools[0]?.name).toBe("cached-tool")
  })
})
