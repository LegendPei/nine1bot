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

  test("applies source-scoped offset pagination to run records", async () => {
    await using tmp = await tmpdir({ git: true })
    const sourceID = `src_page_${Math.random().toString(36).slice(2)}`
    const runIDs: string[] = []
    let projectID: string | undefined

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          projectID = Instance.project.id
          const oldest = await Webhook.createRun({ sourceID, projectID, status: "succeeded" })
          const middle = await Webhook.createRun({ sourceID, projectID, status: "failed" })
          const newest = await Webhook.createRun({ sourceID, projectID, status: "running" })
          runIDs.push(oldest.id, middle.id, newest.id)
          await Webhook.updateRun(oldest.id, { time: { received: 1_000 } })
          await Webhook.updateRun(middle.id, { time: { received: 2_000 } })
          await Webhook.updateRun(newest.id, { time: { received: 3_000 } })

          const response = await WebhookRoutes().request(
            `http://localhost/runs?sourceID=${encodeURIComponent(sourceID)}&limit=1&offset=1`,
          )

          expect(response.status).toBe(200)
          await expect(response.json()).resolves.toEqual([
            expect.objectContaining({ id: middle.id }),
          ])
        },
      })
    } finally {
      for (const runID of runIDs) await Storage.remove(["webhook_run", runID])
      if (projectID) {
        await Storage.remove(["project", projectID])
        await Storage.remove(["project_meta", projectID])
      }
    }
  })
})
