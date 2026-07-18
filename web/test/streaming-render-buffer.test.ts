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
})
