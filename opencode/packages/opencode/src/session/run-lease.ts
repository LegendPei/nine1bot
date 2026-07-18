import { randomUUID } from "crypto"
import { Instance } from "@/project/instance"
import { Session } from "."
import { SessionStatus } from "./status"

export namespace RunLease {
  export type Info = {
    id: string
    sessionID: string
    controller: AbortController
  }

  const state = Instance.state(
    () => ({}) as Record<string, Info>,
    async (current) => Object.values(current).forEach((lease) => lease.controller.abort()),
  )

  export function reserve(sessionID: string): Info {
    if (state()[sessionID]) throw new Session.BusyError(sessionID)
    const lease = {
      id: randomUUID(),
      sessionID,
      controller: new AbortController(),
    }
    state()[sessionID] = lease
    SessionStatus.set(sessionID, { type: "busy" })
    return lease
  }

  export function current(sessionID: string) {
    return state()[sessionID]
  }

  export function cancel(sessionID: string): boolean {
    const lease = state()[sessionID]
    if (!lease) return false
    lease.controller.abort()
    return true
  }

  export function release(sessionID: string, leaseID: string): boolean {
    const lease = state()[sessionID]
    if (!lease || lease.id !== leaseID) return false
    delete state()[sessionID]
    SessionStatus.set(sessionID, { type: "idle" })
    return true
  }
}
