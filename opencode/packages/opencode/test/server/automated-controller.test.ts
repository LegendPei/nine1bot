import { describe, expect, test } from "bun:test"
import { createAndSendAutomatedControllerTurn } from "../../src/server/routes/automated-controller"

describe("automated controller session startup", () => {
  test("binds the created session before sending the first message", async () => {
    const events: string[] = []
    let boundSession: string | undefined

    const result = await createAndSendAutomatedControllerTurn({
      async createSession() {
        return { sessionId: "session-review-1", marker: "created" }
      },
      async onSessionCreated({ sessionID }) {
        events.push("session-bound")
        boundSession = sessionID
      },
      async sendMessage(sessionID) {
        expect(sessionID).toBe("session-review-1")
        expect(boundSession).toBe(sessionID)
        events.push("message-sent")
        return { marker: "sent" }
      },
    })

    expect(events).toEqual(["session-bound", "message-sent"])
    expect(result).toEqual({
      sessionResponse: { sessionId: "session-review-1", marker: "created" },
      messageResponse: { marker: "sent" },
    })
  })
})
