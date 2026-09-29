import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import z from "zod"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: z.string(),
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: z.string(),
      }),
    ),
  }

  const statuses = new Map<string, { projectID: string; status: Info }>()

  export function get(sessionID: string): Info {
    return statuses.get(sessionID)?.status ?? { type: "idle" }
  }

  export function list() {
    return Object.fromEntries(
      [...statuses]
        .filter(([, value]) => value.projectID === Instance.project.id)
        .map(([id, value]) => [id, value.status]),
    )
  }

  export function set(sessionID: string, status: Info) {
    Bus.publish(Event.Status, {
      sessionID,
      status,
    })
    if (status.type === "idle") {
      // deprecated
      Bus.publish(Event.Idle, {
        sessionID,
      })
      statuses.delete(sessionID)
      return
    }
    statuses.set(sessionID, { projectID: Instance.project.id, status })
  }
}
