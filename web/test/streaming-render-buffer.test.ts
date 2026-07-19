import { describe, expect, it } from 'bun:test'
import { createFrameDeltaBuffer } from '../src/composables/streaming-render-buffer'

describe('createFrameDeltaBuffer', () => {
  it('applies coalesced deltas at most once per animation frame', () => {
    const frames: Array<() => void> = []
    const applied: Array<{ messageID: string; partID: string; field: string; delta: string }> = []
    const buffer = createFrameDeltaBuffer({
      schedule(callback) {
        frames.push(callback)
        return frames.length
      },
      cancel() {},
      apply(delta) {
        applied.push(delta)
      },
    })

    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hel' })
    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'lo' })

    expect(frames).toHaveLength(1)
    expect(applied).toHaveLength(0)
    frames[0]()
    expect(applied).toEqual([
      { messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hello' },
    ])
  })

  it('flushes a part synchronously before a full checkpoint replaces it', () => {
    const frames: Array<() => void> = []
    const applied: string[] = []
    const buffer = createFrameDeltaBuffer({
      schedule(callback) {
        frames.push(callback)
        return frames.length
      },
      cancel() {},
      apply(delta) {
        applied.push(delta.delta)
      },
    })

    buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'hello' })
    buffer.flush('part_1')

    expect(applied).toEqual(['hello'])
    frames[0]()
    expect(applied).toEqual(['hello'])
  })

  it('falls back to setTimeout when the document is hidden (background tab)', async () => {
    const applied: string[] = []
    const globalRef = globalThis as Record<string, unknown>
    const originalDocument = globalRef.document
    const originalRaf = globalRef.requestAnimationFrame
    const originalCancelRaf = globalRef.cancelAnimationFrame
    globalRef.document = { hidden: true }
    globalRef.requestAnimationFrame = () => {
      throw new Error('requestAnimationFrame must not be used while the tab is hidden')
    }
    globalRef.cancelAnimationFrame = () => {
      throw new Error('cancelAnimationFrame must not be used while the tab is hidden')
    }
    try {
      const buffer = createFrameDeltaBuffer({
        apply(delta) {
          applied.push(delta.delta)
        },
      })
      buffer.push({ messageID: 'message_1', partID: 'part_1', field: 'text', delta: 'x' })
      // 默认调度在后台标签页改走 setTimeout(100ms)，delta 不应一直积压
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(applied).toEqual(['x'])
    } finally {
      globalRef.document = originalDocument
      globalRef.requestAnimationFrame = originalRaf
      globalRef.cancelAnimationFrame = originalCancelRaf
    }
  })
})
