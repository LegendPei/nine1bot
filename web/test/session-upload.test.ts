import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { api } from '../src/api/client'

class FakeXMLHttpRequest {
  static latest: FakeXMLHttpRequest | undefined

  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {}
  status = 0
  responseText = ''
  aborted = false
  onerror?: () => void
  onabort?: () => void
  onload?: () => void

  constructor() {
    FakeXMLHttpRequest.latest = this
  }

  open() {}
  setRequestHeader() {}
  send() {}

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total })
  }

  respond(status: number, responseText = '') {
    this.status = status
    this.responseText = responseText
    this.onload?.()
  }
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest

beforeEach(() => {
  FakeXMLHttpRequest.latest = undefined
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest
})

afterEach(() => {
  globalThis.XMLHttpRequest = originalXMLHttpRequest
})

describe('session file upload', () => {
  it('aborts after an inactivity window instead of imposing a total upload deadline', async () => {
    const upload = api.uploadSessionFile(
      'session_1',
      new File(['hello'], 'hello.txt', { type: 'text/plain' }),
      { stallTimeoutMs: 30 },
    )
    const request = FakeXMLHttpRequest.latest!

    await Bun.sleep(20)
    request.progress(1, 2)
    await Bun.sleep(20)
    expect(request.aborted).toBe(false)

    const result = await Promise.race([
      upload.catch((error: Error) => error.message),
      Bun.sleep(40).then(() => 'still pending'),
    ])

    expect(request.aborted).toBe(true)
    expect(result).toBe('上传长时间没有进度，请检查网络连接后重试。')
  })

  it('explains HTTP failures that otherwise look like an unresponsive drop', async () => {
    const upload = api.uploadSessionFile(
      'session_1',
      new File(['hello'], 'hello.txt', { type: 'text/plain' }),
    )

    FakeXMLHttpRequest.latest!.respond(404)

    await expect(upload).rejects.toThrow('当前服务不支持会话文件上传（HTTP 404），请确认前后端版本一致。')
  })
})
