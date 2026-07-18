import type { MessageV2 } from "./message-v2"

export namespace PartUpdateBuffer {
  export const DELTA_WINDOW_MS = 50
  export const CHECKPOINT_WINDOW_MS = 500

  export type StreamPart = MessageV2.TextPart | MessageV2.ReasoningPart
  export type Field = "text"
  export type Delta = {
    sessionID: string
    messageID: string
    partID: string
    field: Field
    delta: string
  }

  export type Scheduler = {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(timer: unknown): void
  }

  type Entry = {
    part: StreamPart
    deltas: Map<Field, string>
    version: number
    deltaTimer?: unknown
    checkpointTimer?: unknown
  }

  const scheduler: Scheduler = {
    setTimeout(callback, delay) {
      return setTimeout(callback, delay)
    },
    clearTimeout(timer) {
      clearTimeout(timer as ReturnType<typeof setTimeout>)
    },
  }

  export function create(input: {
    emitDelta(delta: Delta): unknown
    persist(part: StreamPart): unknown
    scheduler?: Scheduler
    deltaWindowMs?: number
    checkpointWindowMs?: number
    onError?(error: unknown): void
  }) {
    const entries = new Map<string, Entry>()
    const clock = input.scheduler ?? scheduler
    const deltaWindowMs = input.deltaWindowMs ?? DELTA_WINDOW_MS
    const checkpointWindowMs = input.checkpointWindowMs ?? CHECKPOINT_WINDOW_MS
    let serial = Promise.resolve()

    const enqueue = (task: () => void | Promise<void>) => {
      const result = serial.then(task)
      serial = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }

    const report = (error: unknown) => input.onError?.(error)

    const emitPending = async (entry: Entry) => {
      const deltas = [...entry.deltas]
      entry.deltas.clear()
      for (const [field, delta] of deltas) {
        if (!delta) continue
        await input.emitDelta({
          sessionID: entry.part.sessionID,
          messageID: entry.part.messageID,
          partID: entry.part.id,
          field,
          delta,
        })
      }
    }

    const clearTimer = (entry: Entry, key: "deltaTimer" | "checkpointTimer") => {
      const timer = entry[key]
      if (timer === undefined) return
      clock.clearTimeout(timer)
      entry[key] = undefined
    }

    const flushEntry = async (partID: string) => {
      const entry = entries.get(partID)
      if (!entry) return
      clearTimer(entry, "deltaTimer")
      clearTimer(entry, "checkpointTimer")
      const version = entry.version
      const part = snapshot(entry.part)
      await emitPending(entry)
      await input.persist(part)
      if (entries.get(partID) === entry && entry.version === version && entry.deltas.size === 0) {
        entries.delete(partID)
      }
    }

    const scheduleDelta = (entry: Entry) => {
      if (entry.deltaTimer !== undefined) return
      entry.deltaTimer = clock.setTimeout(() => {
        entry.deltaTimer = undefined
        void enqueue(() => emitPending(entry)).catch(report)
      }, deltaWindowMs)
    }

    const scheduleCheckpoint = (entry: Entry) => {
      if (entry.checkpointTimer !== undefined) return
      entry.checkpointTimer = clock.setTimeout(() => {
        entry.checkpointTimer = undefined
        void enqueue(() => flushEntry(entry.part.id)).catch(report)
      }, checkpointWindowMs)
    }

    const updateEntry = (part: StreamPart) => {
      const existing = entries.get(part.id)
      if (existing) {
        existing.part = snapshot(part)
        existing.version++
        return existing
      }
      const entry: Entry = {
        part: snapshot(part),
        deltas: new Map(),
        version: 1,
      }
      entries.set(part.id, entry)
      return entry
    }

    return {
      push(part: StreamPart, field: Field, delta: string) {
        if (!delta) return
        const entry = updateEntry(part)
        entry.deltas.set(field, (entry.deltas.get(field) ?? "") + delta)
        scheduleDelta(entry)
        scheduleCheckpoint(entry)
      },
      checkpoint(part: StreamPart) {
        updateEntry(part)
        return enqueue(() => flushEntry(part.id))
      },
      flush(partID: string) {
        return enqueue(() => flushEntry(partID))
      },
      flushAll() {
        return enqueue(async () => {
          for (const partID of [...entries.keys()]) {
            await flushEntry(partID)
          }
        })
      },
      idle() {
        return serial
      },
    }
  }

  function snapshot(part: StreamPart): StreamPart {
    const result = { ...part } as StreamPart
    if (part.time) result.time = { ...part.time }
    if (part.metadata) result.metadata = { ...part.metadata }
    return result
  }
}
