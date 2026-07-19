export type FrameDelta = {
  messageID: string
  partID: string
  field: string
  delta: string
}

export function createFrameDeltaBuffer(input: {
  apply(delta: FrameDelta): void
  schedule?: (callback: () => void) => number
  cancel?: (handle: number) => void
}) {
  const pending = new Map<string, FrameDelta>()
  // 后台标签页 rAF 停发，会造成 delta 一直积压；隐藏时改用 setTimeout 兜底
  let scheduledWithTimeout = false
  const schedule = input.schedule ?? ((callback: () => void) => {
    if (typeof document !== 'undefined' && document.hidden) {
      scheduledWithTimeout = true
      return setTimeout(callback, 100) as unknown as number
    }
    scheduledWithTimeout = false
    return requestAnimationFrame(callback)
  })
  const cancel = input.cancel ?? ((handle: number) => {
    if (scheduledWithTimeout) {
      clearTimeout(handle)
    } else {
      cancelAnimationFrame(handle)
    }
  })
  let frame: number | undefined

  const keyFor = (delta: Pick<FrameDelta, 'messageID' | 'partID' | 'field'>) =>
    `${delta.messageID}\u0000${delta.partID}\u0000${delta.field}`

  const applyPending = (partID?: string) => {
    for (const [key, delta] of pending) {
      if (partID && delta.partID !== partID) continue
      pending.delete(key)
      input.apply(delta)
    }
  }

  const scheduleFrame = () => {
    if (frame !== undefined) return
    frame = schedule(() => {
      frame = undefined
      applyPending()
    })
  }

  return {
    push(delta: FrameDelta) {
      if (!delta.delta) return
      const key = keyFor(delta)
      const existing = pending.get(key)
      pending.set(key, existing ? { ...delta, delta: existing.delta + delta.delta } : delta)
      scheduleFrame()
    },
    flush(partID?: string) {
      applyPending(partID)
      if (pending.size === 0 && frame !== undefined) {
        cancel(frame)
        frame = undefined
      }
    },
    clear() {
      pending.clear()
      if (frame !== undefined) cancel(frame)
      frame = undefined
    },
  }
}
