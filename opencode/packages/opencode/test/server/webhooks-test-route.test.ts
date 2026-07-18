import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { WebhookRoutes } from "../../src/server/routes/webhooks"
import { Storage } from "../../src/storage/storage"
import { Webhook } from "../../src/webhook/webhook"
import { tmpdir } from "../fixture/fixture"

describe("webhook management test route", () => {
  test("reuses webhook guards without requiring the one-time source secret", async () => {
    await using tmp = await tmpdir({ git: true })
    let sourceID: string | undefined
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const created = await Webhook.createSource({
            name: "Management test",
            projectID: Instance.project.id,
            requestGuards: {
              dedupe: { enabled: false, ttlSeconds: 3600 },
              rateLimit: { enabled: false, maxRequests: 20, windowSeconds: 60 },
              cooldown: { enabled: false, seconds: 0 },
              replayProtection: {
                enabled: true,
                timestampHeader: "x-nine1bot-timestamp",
                maxSkewSeconds: 300,
              },
            },
          })
          sourceID = created.source.id

          const response = await WebhookRoutes().request(
            `http://localhost/sources/${encodeURIComponent(created.source.id)}/test`,
            {
              method: 'POST',
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ monitor: { status: "down" } }),
            },
          )

          expect(response.status).toBe(400)
          await expect(response.json()).resolves.toMatchObject({
            accepted: false,
            error: "webhook_replay_timestamp_missing",
            guardType: "replayProtection",
          })
        },
      })
    } finally {
      if (sourceID) await Storage.remove(["webhook_source", sourceID])
      if (projectID) {
        await Storage.remove(["project", projectID])
        await Storage.remove(["project_meta", projectID])
      }
    }
  })
})
