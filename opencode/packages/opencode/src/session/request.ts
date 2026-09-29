import { createHash } from "node:crypto"
import { HTTPException } from "hono/http-exception"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import type { SessionPrompt } from "./prompt"

/** Receipts belong to client-supplied message IDs; generated IDs need no replay lookup. */
export namespace SessionRequest {
  type Receipt = { sessionID: string; hash: string; turnSnapshotId?: string }
  const key = (messageID: string) => ["message_request", messageID]
  function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, stable(value)]),
      )
    return value
  }
  function hash(input: SessionPrompt.PromptInput) {
    const { parts, model, agent, system, tools, variant, noReply, context } = input
    return createHash("sha256")
      .update(JSON.stringify(stable({ parts, model, agent, system, tools, variant, noReply, context })))
      .digest("hex")
  }
  export async function replay(input: SessionPrompt.PromptInput) {
    if (!input.messageID) return undefined
    const receipt = await Storage.read<Receipt>(key(input.messageID)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
    if (!receipt) return undefined
    if (receipt.sessionID !== input.sessionID || receipt.hash !== hash(input)) {
      throw new HTTPException(409, {
        message: "Message ID already belongs to another request; reload the conversation before retrying",
      })
    }
    return receipt
  }
  export async function isAccepted(sessionID: string, messageID?: string) {
    if (!messageID) return false
    const receipt = await Storage.read<Receipt>(key(messageID)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
    return receipt?.sessionID === sessionID
  }
  export async function lock(messageID?: string): Promise<Disposable> {
    return messageID ? Lock.write(`message-request:${messageID}`) : { [Symbol.dispose]() {} }
  }
  export async function assertNew(input: SessionPrompt.PromptInput) {
    if (!input.messageID) return
    const messages = await Storage.read(["message", input.sessionID, input.messageID]).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return undefined
      throw error
    })
    const parts = await Storage.list(["part", input.messageID])
    if (messages || parts.length)
      throw new HTTPException(409, { message: "Message ID already exists; reload the conversation before retrying" })
  }
  export async function accept(input: SessionPrompt.PromptInput) {
    if (!input.messageID) return
    await Storage.write<Receipt>(key(input.messageID), {
      sessionID: input.sessionID,
      hash: hash(input),
      turnSnapshotId: input.runtimeTurnSnapshotId,
    })
  }
  export async function remove(messageID: string) {
    await Storage.remove(key(messageID))
  }
}
