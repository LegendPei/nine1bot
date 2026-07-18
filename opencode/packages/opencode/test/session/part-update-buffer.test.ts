import { describe, expect, test } from "bun:test"
import { PartUpdateBuffer } from "../../src/session/part-update-buffer"

type Timer = { callback: () => void; delay: number; cancelled: boolean }

function harness() {
  const timers: Timer[] = []
  const deltas: PartUpdateBuffer.Delta[] = []
  const checkpoints: PartUpdateBuffer.StreamPart[] = []
  const scheduler: PartUpdateBuffer.Scheduler = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(timer) {
      ;(timer as Timer).cancelled = true
    },
  }
  const buffer = PartUpdateBuffer.create({
    scheduler,
    emitDelta(delta) {
      deltas.push(delta)
    },
    persist(part) {
      checkpoints.push(part)
    },
  })
  const run = async (delay: number) => {
    for (const timer of timers.filter((item) => !item.cancelled && item.delay === delay)) {
      timer.cancelled = true
      timer.callback()
    }
    await buffer.idle()
  }
  return { buffer, deltas, checkpoints, run }
}

function part(text: string): PartUpdateBuffer.StreamPart {
  return {
    id: "part_1",
    messageID: "message_1",
    sessionID: "session_1",
    type: "text",
    text,
    time: { start: 1 },
  }
}

describe("PartUpdateBuffer", () => {
  test("coalesces token deltas within the short emission window", async () => {
    const test = harness()

    test.buffer.push(part("hel"), "text", "hel")
    test.buffer.push(part("hello"), "text", "lo")
    await test.run(50)

    expect(test.deltas).toEqual([
      {
        sessionID: "session_1",
        messageID: "message_1",
        partID: "part_1",
        field: "text",
        delta: "hello",
      },
    ])
    expect(test.checkpoints).toHaveLength(0)
  })

  test("persists a full checkpoint after the checkpoint window", async () => {
    const test = harness()

    test.buffer.push(part("hello"), "text", "hello")
    await test.run(500)

    expect(test.deltas.map((item) => item.delta)).toEqual(["hello"])
    expect(test.checkpoints).toEqual([part("hello")])
  })

  test("flushes pending delta and the final part before a transition", async () => {
    const test = harness()

    test.buffer.push(part("hello"), "text", "hello")
    await test.buffer.checkpoint({
      ...part("hello"),
      time: { start: 1, end: 2 },
    })

    expect(test.deltas.map((item) => item.delta)).toEqual(["hello"])
    expect(test.checkpoints[0]?.time).toEqual({ start: 1, end: 2 })
  })

  test("does not include concurrently arriving delta text in an earlier checkpoint", async () => {
    let releaseDelta!: () => void
    let markDeltaStarted!: () => void
    const deltaStarted = new Promise<void>((resolve) => (markDeltaStarted = resolve))
    const deltaReleased = new Promise<void>((resolve) => (releaseDelta = resolve))
    const deltas: string[] = []
    const checkpoints: PartUpdateBuffer.StreamPart[] = []
    const buffer = PartUpdateBuffer.create({
      scheduler: {
        setTimeout() {
          return {}
        },
        clearTimeout() {},
      },
      async emitDelta(delta) {
        deltas.push(delta.delta)
        markDeltaStarted()
        await deltaReleased
      },
      persist(part) {
        checkpoints.push(part)
      },
    })

    buffer.push(part("hello"), "text", "hello")
    const firstFlush = buffer.flush("part_1")
    await deltaStarted
    buffer.push(part("hello!"), "text", "!")
    releaseDelta()
    await firstFlush

    expect(checkpoints[0]?.text).toBe("hello")
    await buffer.flush("part_1")
    expect(deltas).toEqual(["hello", "!"])
    expect(checkpoints[1]?.text).toBe("hello!")
  })
})
