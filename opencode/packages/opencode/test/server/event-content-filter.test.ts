import { describe, expect, test } from "bun:test"
import { shouldSendEvent } from "../../src/server/event-filter"

describe("shouldSendEvent", () => {
  test("keeps all events for the default event stream", () => {
    expect(shouldSendEvent({ type: "message.part.updated" }, true)).toBe(true)
    expect(shouldSendEvent({ type: "session.status" }, true)).toBe(true)
  })

  test("drops streamed message content when content is disabled", () => {
    expect(shouldSendEvent({ type: "message.part.updated" }, false)).toBe(false)
    expect(shouldSendEvent({ type: "message.part.delta" }, false)).toBe(false)
    expect(
      shouldSendEvent(
        {
          directory: "/workspace",
          payload: { type: "message.part.updated" },
        },
        false,
      ),
    ).toBe(false)
  })

  test("keeps control events when content is disabled", () => {
    expect(shouldSendEvent({ type: "session.status" }, false)).toBe(true)
    expect(
      shouldSendEvent(
        {
          directory: "/workspace",
          payload: { type: "question.asked" },
        },
        false,
      ),
    ).toBe(true)
  })
})
