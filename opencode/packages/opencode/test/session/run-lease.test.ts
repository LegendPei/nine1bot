import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { RunLease } from "../../src/session/run-lease"
import { tmpdir } from "../fixture/fixture"

describe("RunLease", () => {
  test("cancel aborts but keeps the session reserved until its owner releases", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lease = RunLease.reserve("session_test")

        expect(RunLease.cancel("session_test")).toBe(true)
        expect(lease.controller.signal.aborted).toBe(true)
        expect(() => RunLease.reserve("session_test")).toThrow()
        expect(RunLease.release("session_test", lease.id)).toBe(true)
        expect(RunLease.current("session_test")).toBeUndefined()
      },
    })
  })

  test("an old owner cannot release a newer lease", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = RunLease.reserve("session_test")
        expect(RunLease.release("session_test", first.id)).toBe(true)

        const second = RunLease.reserve("session_test")
        expect(RunLease.release("session_test", first.id)).toBe(false)
        expect(RunLease.current("session_test")?.id).toBe(second.id)
        expect(RunLease.release("session_test", second.id)).toBe(true)
      },
    })
  })
})
