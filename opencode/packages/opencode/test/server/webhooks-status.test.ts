import { describe, expect, test } from "bun:test"
import { publicGitLabReviewRun, webhookLocalOrigin } from "../../src/server/routes/webhooks"

describe("webhook status URL selection", () => {
  test("uses configured local URL when provided", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      envLocalUrl: "http://bot.example.test:4096/",
      interfaces: {},
    })).toBe("http://bot.example.test:4096")
  })

  test("replaces loopback browser origin with a reachable LAN IPv4", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://127.0.0.1:4096",
      interfaces: {
        Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true } as any],
        Ethernet: [{ address: "192.168.53.6", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("keeps non-loopback origins unchanged", () => {
    expect(webhookLocalOrigin({
      requestOrigin: "http://192.168.53.6:4096",
      interfaces: {
        Ethernet: [{ address: "10.0.0.12", family: "IPv4", internal: false } as any],
      },
    })).toBe("http://192.168.53.6:4096")
  })

  test("omits heavy GitLab review context from list records", () => {
    expect(publicGitLabReviewRun({
      id: "run_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
      context: {
        diff: {
          files: [{ diff: "large diff" }],
        },
      },
    } as any)).toEqual({
      id: "run_1",
      platform: "gitlab",
      status: "succeeded",
      createdAt: 1,
      updatedAt: 2,
    })
  })
})
