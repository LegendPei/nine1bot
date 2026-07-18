import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import type { SessionProfileSnapshot } from "../../src/runtime/protocol/agent-run-spec"
import { RuntimeControllerEvents } from "../../src/runtime/controller/events"
import { Bus } from "../../src/bus"
import { RunLease } from "../../src/session/run-lease"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function createTestSession() {
  const profile: SessionProfileSnapshot = {
    id: "profile_session_busy_test",
    createdAt: Date.now(),
    source: "new-session",
    sourceTemplateIds: ["session-busy-test"],
    agent: {
      name: "build",
      source: "default-user-template",
    },
    defaultModel: {
      providerID: "test-provider",
      modelID: "test-model",
      source: "default-user-template",
    },
    context: {
      blocks: [],
    },
    resources: {
      builtinTools: {},
      mcp: {
        servers: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      skills: {
        skills: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
    },
    permissions: {
      rules: {},
      source: [],
      mergeMode: "strict",
    },
    orchestration: {
      mode: "single",
    },
  }
  return Session.createNext({
    directory: Instance.directory,
    runtimeProfile: profile,
  })
}

describe("session.prompt busy semantics", () => {
  test("keeps cancelled sessions busy until the lease owner exits", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()

        const lease = SessionPrompt._testing.reserve(session.id)
        expect(SessionStatus.get(session.id).type).toBe("busy")

        expect(SessionPrompt.cancel(session.id)).toBe(true)
        expect(SessionStatus.get(session.id).type).toBe("busy")

        expect(SessionPrompt._testing.release(session.id, lease.id)).toBe(true)
        expect(SessionStatus.get(session.id).type).toBe("idle")

        await Session.remove(session.id)
      },
    })
  })

  test("rejects busy prompts before cleanup or message persistence", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()

        const lease = SessionPrompt._testing.reserve(session.id)
        await Session.update(session.id, (draft) => {
          draft.revert = {
            messageID: "message_busy_marker",
          }
        })

        const beforeMessages = await Session.messages({ sessionID: session.id })

        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            parts: [
              {
                type: "text",
                text: "blocked while busy",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(Session.BusyError)

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)
        expect((await Session.get(session.id)).revert?.messageID).toBe("message_busy_marker")

        SessionPrompt.cancel(session.id)
        SessionPrompt._testing.release(session.id, lease.id)
        await Session.remove(session.id)
      },
    })
  })

  test("rejects busy noReply prompts before persisting a message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()

        const lease = SessionPrompt._testing.reserve(session.id)
        const beforeMessages = await Session.messages({ sessionID: session.id })

        await expect(
          SessionPrompt.prompt({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: "noReply should still be rejected",
              },
            ],
          }),
        ).rejects.toBeInstanceOf(Session.BusyError)

        const afterMessages = await Session.messages({ sessionID: session.id })
        expect(afterMessages.length).toBe(beforeMessages.length)

        SessionPrompt.cancel(session.id)
        SessionPrompt._testing.release(session.id, lease.id)
        await Session.remove(session.id)
      },
    })
  })

  test("persists idle noReply prompts without leaving the session busy", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          noReply: true,
          model: {
            providerID: "test-provider",
            modelID: "test-model",
          },
          parts: [
            {
              type: "text",
              text: "persist without starting the loop",
            },
          ],
        })

        expect(message.info.role).toBe("user")
        expect(SessionStatus.get(session.id).type).toBe("idle")

        const messages = await Session.messages({ sessionID: session.id })
        expect(messages).toHaveLength(1)
        expect(messages[0]?.info.id).toBe(message.info.id)

        await Session.remove(session.id)
      },
    })
  })

  test("releases the lease and publishes the real error when session loading fails", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()
        const sessionID = session.id
        await Session.remove(sessionID)

        const failed: Array<{ properties: { errorMessage?: string } }> = []
        const unsubscribe = Bus.subscribe(RuntimeControllerEvents.TurnFailed, (event) => failed.push(event))
        try {
          await expect(
            SessionPrompt.prompt({
              sessionID,
              runtimeTurnSnapshotId: "turn_missing_session",
              noReply: true,
              model: {
                providerID: "test-provider",
                modelID: "test-model",
              },
              parts: [{ type: "text", text: "missing session" }],
            }),
          ).rejects.toThrow()

          expect(RunLease.current(sessionID)).toBeUndefined()
          expect(failed).toHaveLength(1)
          expect(failed[0]?.properties.errorMessage).toBeTruthy()
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("publishes started then exactly one completed event for an accepted noReply turn", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()
        const events: string[] = []
        const unsubscribers = [
          Bus.subscribe(RuntimeControllerEvents.TurnStarted, (event) => events.push(event.type)),
          Bus.subscribe(RuntimeControllerEvents.TurnCompleted, (event) => events.push(event.type)),
          Bus.subscribe(RuntimeControllerEvents.TurnFailed, (event) => events.push(event.type)),
          Bus.subscribe(RuntimeControllerEvents.TurnCancelled, (event) => events.push(event.type)),
        ]

        try {
          await SessionPrompt.promptAsync({
            sessionID: session.id,
            runtimeTurnSnapshotId: "turn_no_reply",
            noReply: true,
            model: {
              providerID: "test-provider",
              modelID: "test-model",
            },
            parts: [{ type: "text", text: "persist only" }],
          })

          expect(events).toEqual(["runtime.turn.started", "runtime.turn.completed"])
          expect(RuntimeControllerEvents.turnSnapshotIdFor(session.id)).toBeUndefined()
        } finally {
          unsubscribers.forEach((unsubscribe) => unsubscribe())
          await Session.remove(session.id)
        }
      },
    })
  })

  test("publishes the original loop exception instead of a generic terminal error", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createTestSession()
        const failed: Array<{ properties: { errorMessage?: string } }> = []
        const unsubscribe = Bus.subscribe(RuntimeControllerEvents.TurnFailed, (event) => failed.push(event))
        RuntimeControllerEvents.bindTurn(session.id, "turn_empty_loop")

        try {
          await expect(SessionPrompt.loop(session.id)).rejects.toThrow("No user message found")
          expect(failed).toHaveLength(1)
          expect(failed[0]?.properties.errorMessage).toContain("No user message found")
        } finally {
          unsubscribe()
          RuntimeControllerEvents.clearTurn(session.id, "turn_empty_loop")
          await Session.remove(session.id)
        }
      },
    })
  })
})
