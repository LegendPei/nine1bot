import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { AuthConfigSchema } from '../config/schema'
import { FileAccessCredentialStore, hashAccessPassword } from './credential-store'
import { AccessAuthService, LoginLimiter, createAccessAuthRuntime } from './service'

const password = 'correct horse battery'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function context(url: string, init: RequestInit = {}) {
  const request = new Request(url, init)
  return {
    req: {
      raw: request,
      path: new URL(url).pathname,
      method: request.method,
      url: request.url,
      header(name: string) {
        return request.headers.get(name) ?? undefined
      },
      json() {
        return request.json()
      },
    },
    json(body: unknown, status = 200, headers: Record<string, string> = {}) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
      })
    },
  }
}

async function createService(): Promise<AccessAuthService> {
  return new AccessAuthService({
    config: AuthConfigSchema.parse({ enabled: true }),
    passwordHash: await hashAccessPassword(password),
    credentialVersion: 1,
  })
}

async function dispatch(
  service: AccessAuthService,
  url: string,
  init: RequestInit = {},
  remoteAddress = '192.168.1.25',
) {
  let continued = false
  const response = await service.handle(
    context(url, init),
    async () => { continued = true },
    { remoteAddress, localBrowserRelay: false },
  )
  return { response, continued }
}

describe('AccessAuthService WebUI sessions', () => {
  it('supports password login over plain HTTP without setting a Secure cookie', async () => {
    const service = await createService()
    const login = await dispatch(service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password, surface: 'web' }),
    })

    expect(login.response?.status).toBe(200)
    const cookie = login.response?.headers.get('Set-Cookie') || ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).not.toContain('Secure')

    const authenticated = await dispatch(service, 'http://192.168.1.10:4096/session', {
      headers: { Cookie: cookie.split(';')[0] },
    })
    expect(authenticated.continued).toBe(true)
  })

  it('sets Secure on HTTPS sessions', async () => {
    const service = await createService()
    const login = await dispatch(service, 'https://bot.example.com/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://bot.example.com' },
      body: JSON.stringify({ password, surface: 'web' }),
    })
    expect(login.response?.headers.get('Set-Cookie')).toContain('Secure')
  })

  it('checks Origin on cookie logout and revokes the session', async () => {
    const service = await createService()
    const login = await dispatch(service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password, surface: 'web' }),
    })
    const cookie = (login.response?.headers.get('Set-Cookie') || '').split(';')[0]

    const rejected = await dispatch(service, 'http://192.168.1.10:4096/access-auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://attacker.example' },
    })
    expect(rejected.response?.status).toBe(403)

    const logout = await dispatch(service, 'http://192.168.1.10:4096/access-auth/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://192.168.1.10:4096' },
    })
    expect(logout.response?.status).toBe(204)
    expect(logout.response?.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect((await dispatch(service, 'http://192.168.1.10:4096/config', {
      headers: { Cookie: cookie },
    })).response?.status).toBe(401)
  })

  it('returns JSON 401 without a Basic challenge for protected APIs', async () => {
    const service = await createService()
    const result = await dispatch(service, 'http://192.168.1.10:4096/session')
    expect(result.response?.status).toBe(401)
    expect(result.response?.headers.has('WWW-Authenticate')).toBe(false)
    expect(await result.response?.json()).toEqual({
      error: { code: 'access_auth_required', message: 'Web access authentication is required' },
    })
  })

  it('keeps the legacy Basic scheme case-insensitive without sending a challenge', async () => {
    const service = await createService()
    const encoded = Buffer.from(`nine1bot:${password}`).toString('base64')
    const result = await dispatch(service, 'http://192.168.1.10:4096/config', {
      headers: { Authorization: `basic ${encoded}` },
    })
    expect(result.continued).toBe(true)
  })

  it('ignores malformed cookies instead of returning a server error', async () => {
    const service = await createService()
    const result = await dispatch(service, 'http://192.168.1.10:4096/session', {
      headers: { Cookie: 'nine1bot_access_session=%' },
    })
    expect(result.response?.status).toBe(401)
  })

  it('rejects chunked login bodies after the byte limit', async () => {
    const service = await createService()
    const result = await dispatch(service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password: 'x'.repeat(1500), surface: 'web' }),
    })
    expect(result.response?.status).toBe(413)
  })

  it('serves the login shell publicly but protects other application routes', async () => {
    const service = await createService()
    expect((await dispatch(service, 'http://192.168.1.10:4096/')).continued).toBe(true)
    expect((await dispatch(service, 'http://192.168.1.10:4096/assets/app.js')).continued).toBe(true)
    expect((await dispatch(service, 'http://192.168.1.10:4096/config')).response?.status).toBe(401)
  })

  it('rate limits a peer after five failed password attempts', async () => {
    const service = await createService()
    const attempt = () => dispatch(service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password: 'definitely incorrect', surface: 'web' }),
    })

    for (let index = 0; index < 5; index++) {
      expect((await attempt()).response?.status).toBe(401)
    }
    const limited = await attempt()
    expect(limited.response?.status).toBe(429)
    expect(limited.response?.headers.get('Retry-After')).toBe('30')
  })
})

describe('createAccessAuthRuntime fail-closed behavior', () => {
  it('refuses enabled auth without any credential before a server can bind', async () => {
    const store = { load: async () => undefined }
    await expect(createAccessAuthRuntime(
      AuthConfigSchema.parse({ enabled: true }),
      { store: store as any, env: {} },
    )).rejects.toThrow('no password is configured')
  })

  it('accepts a deployment password from the environment without storing it', async () => {
    const store = { load: async () => { throw new Error('store should not be read') } }
    const runtime = await createAccessAuthRuntime(
      AuthConfigSchema.parse({ enabled: true }),
      { store: store as any, env: { NINE1BOT_WEB_PASSWORD: password } },
    )
    expect(runtime.state).toBe('active')
  })

  it('rejects a malformed credential hash during runtime construction', async () => {
    const store = {
      load: async () => ({
        schemaVersion: 1,
        passwordHash: '$argon2id$malformed',
        credentialVersion: 1,
        updatedAt: new Date().toISOString(),
      }),
    }
    await expect(createAccessAuthRuntime(
      AuthConfigSchema.parse({ enabled: true }),
      { store: store as any, env: {} },
    )).rejects.toThrow('credential hash is invalid')
  })

  it('reloads a rotated credential and revokes existing sessions without restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nine1bot-live-auth-'))
    tempDirs.push(directory)
    const store = new FileAccessCredentialStore(join(directory, 'access-auth.json'))
    await store.setPassword(password)
    const runtime = await createAccessAuthRuntime(
      AuthConfigSchema.parse({ enabled: true }),
      { store, env: {} },
    )
    const login = await dispatch(runtime.service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password, surface: 'web' }),
    })
    const cookie = (login.response?.headers.get('Set-Cookie') || '').split(';')[0]

    await store.setPassword('replacement secure password')
    expect((await dispatch(runtime.service, 'http://192.168.1.10:4096/config', {
      headers: { Cookie: cookie },
    })).response?.status).toBe(401)
    expect((await dispatch(runtime.service, 'http://192.168.1.10:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://192.168.1.10:4096' },
      body: JSON.stringify({ password: 'replacement secure password', surface: 'web' }),
    })).response?.status).toBe(200)
  })
})

describe('LoginLimiter global failure bucket', () => {
  it('blocks distributed attempts after the configured global threshold', () => {
    const limiter = new LoginLimiter(3)
    for (const key of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      limiter.begin(key).finish()
      limiter.failed(key)
    }
    expect(() => limiter.begin('198.51.100.4')).toThrow('global failed login attempts')
  })
})

describe('AccessAuthService extension and internal sessions', () => {
  it('issues a bearer token to a loopback extension login with explicit CORS', async () => {
    const service = await createService()
    const origin = 'chrome-extension://abcdefghijklmnop'
    const login = await dispatch(service, 'http://127.0.0.1:4096/access-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ password, surface: 'browser-extension' }),
    }, '127.0.0.1')
    const body = await login.response?.json() as { accessToken: string }

    expect(login.response?.status).toBe(200)
    expect(login.response?.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(body.accessToken.length).toBeGreaterThan(32)
    expect((await dispatch(service, 'http://127.0.0.1:4096/session', {
      headers: { Authorization: `Bearer ${body.accessToken}` },
    }, '127.0.0.1')).continued).toBe(true)
  })

  it('limits the internal token to loopback requests and internal route prefixes', async () => {
    const service = await createService()
    const authorization = service.createInternalAuthorization()

    expect((await dispatch(service, 'http://127.0.0.1:4096/session/abc', {
      headers: { Authorization: authorization },
    }, '127.0.0.1')).continued).toBe(true)
    expect((await dispatch(service, 'http://127.0.0.1:4096/config', {
      headers: { Authorization: authorization },
    }, '127.0.0.1')).response?.status).toBe(401)
    expect((await dispatch(service, 'http://192.168.1.10:4096/session/abc', {
      headers: { Authorization: authorization },
    }, '192.168.1.25')).response?.status).toBe(401)
  })
})
