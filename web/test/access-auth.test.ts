import { afterEach, describe, expect, it } from 'bun:test'

const originalWindow = globalThis.window

afterEach(() => {
  Object.assign(globalThis, { window: originalWindow })
})

describe('Web access fetch interceptor', () => {
  it('adds the extension bearer only to same-origin requests and centralizes protected 401 handling', async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    let nextStatus = 200
    const fakeWindow = {
      location: {
        href: 'http://127.0.0.1:4096/',
        origin: 'http://127.0.0.1:4096',
      },
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ input, init })
        return new Response('{}', { status: nextStatus, headers: { 'Content-Type': 'application/json' } })
      },
    }
    Object.assign(globalThis, { window: fakeWindow })

    const auth = await import('../src/api/access-auth')
    let unauthorized = 0
    auth.setAccessToken('extension-session-token')
    auth.setAccessUnauthorizedHandler(() => { unauthorized += 1 })
    auth.installAccessFetchInterceptor()

    await fakeWindow.fetch('/session')
    expect(new Headers(requests.at(-1)?.init?.headers).get('Authorization')).toBe(
      'Bearer extension-session-token',
    )

    await fakeWindow.fetch('https://example.com/external')
    expect(new Headers(requests.at(-1)?.init?.headers).has('Authorization')).toBe(false)

    nextStatus = 401
    await fakeWindow.fetch('/session')
    expect(unauthorized).toBe(1)
    await fakeWindow.fetch('/access-auth/status')
    expect(unauthorized).toBe(1)
  })
})
