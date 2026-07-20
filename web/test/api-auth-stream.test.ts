import { afterEach, describe, expect, it } from 'bun:test'
import { createFetchEventStream } from '../src/api/client'

const nativeFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = nativeFetch
})

describe('authenticated fetch event stream', () => {
  it('parses an SSE event split across a CRLF chunk boundary', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

    const received: string[] = []
    const subscription = createFetchEventStream('/event', (data) => received.push(data))
    await subscription.ready
    const encoder = new TextEncoder()
    streamController.enqueue(encoder.encode('data: {"ok": true}\r'))
    streamController.enqueue(encoder.encode('\n\r\n'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(received).toEqual(['{"ok": true}'])
    subscription.close()
  })

  it('rejects readiness and gives up immediately on an authentication 401', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    let giveUpCount = 0
    const subscription = createFetchEventStream('/event', () => {}, {
      onGiveUp: () => { giveUpCount += 1 },
    })

    await expect(subscription.ready).rejects.toThrow('closed before opening')
    expect(giveUpCount).toBe(1)
    subscription.close()
  })
})
