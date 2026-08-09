import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import { inspectGitLabCiForSession } from './gitlab-ci-inspector'
import { ReviewRunStore } from './run-store'

const platforms = {
  gitlab: {
    enabled: true,
    settings: {
      'review.enabled': true,
      'review.baseUrl': 'https://gitlab.example.com',
      'review.tokenSecretRef': {
        provider: 'nine1bot-local',
        key: 'gitlab-token',
      },
    },
  },
} satisfies PlatformManagerConfig

const secrets: PlatformSecretAccess = {
  async get(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-token' ? 'server-side-token' : undefined
  },
  async set() {},
  async delete() {},
  async has(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-token'
  },
}

const tempDirs: string[] = []

describe('GitLab CI session inspector', () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nine1bot-ci-inspector-'))
    tempDirs.push(dir)
    ReviewRunStore.setPathForTesting(join(dir, 'review-runs.json'))
    ReviewRunStore.clearForTesting()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('binds CI lookup to exactly one review session and its project snapshot', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    createReviewRun('session-b', 4, 11, 'head-b')
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      expect(new Headers(init?.headers).get('private-token')).toBe('server-side-token')
      if (url.includes('/projects/3/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'running' }])
      }
      if (url.includes('/projects/3/pipelines/55/jobs')) {
        return Response.json([
          { id: 56, name: 'build', status: 'success' },
          { id: 57, name: 'test', status: 'failed' },
          { id: 58, name: 'deploy', status: 'running' },
        ])
      }
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    const unbound = await inspectGitLabCiForSession({
      sessionId: 'unknown-session',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(unbound).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'gitlab_review_session_not_bound',
    })
    expect(calls).toHaveLength(0)

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'list',
      target: {
        host: 'gitlab.example.com',
        projectId: 3,
        mrIid: 10,
        headSha: 'head-a',
        mrUrl: 'https://gitlab.example.com/root/uftest/-/merge_requests/10',
      },
      pipeline: { id: 55, sha: 'head-a', status: 'running' },
      jobs: [
        { id: 56, name: 'build', status: 'success' },
        { id: 57, name: 'test', status: 'failed' },
        { id: 58, name: 'deploy', status: 'running' },
      ],
      diagnostics: [],
    })
    expect(calls).toHaveLength(2)
    expect(calls.every((url) => url.includes('/projects/3/'))).toBe(true)

    const runA = ReviewRunStore.findBySessionId('session-a')
    const runB = ReviewRunStore.findBySessionId('session-b')
    expect(runA?.ci).toMatchObject({
      pipeline: { id: 55 },
      diagnostics: [],
      queryCount: 1,
    })
    expect(runA?.ci?.observedAt).toBeNumber()
    expect(runB?.ci).toBeUndefined()
  })

  test('fails closed before GitLab access when the configured token is unavailable', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    let fetchCalls = 0
    const missingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        return undefined
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets: missingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_token_missing',
    })
    expect(fetchCalls).toBe(0)
  })

  test('converts secret-store failures into stable diagnostics without GitLab access', async () => {
    createReviewRun('session-a', 3, 10, 'head-a')
    let fetchCalls = 0
    const throwingSecrets: PlatformSecretAccess = {
      ...secrets,
      async get() {
        throw new Error('secret backend details')
      },
    }

    const result = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets: throwingSecrets,
      fetch: (async () => {
        fetchCalls += 1
        return Response.json([])
      }) as unknown as typeof fetch,
    })

    expect(result).toEqual({
      ok: false,
      action: 'list',
      diagnostic: 'ci_token_unavailable:Error',
    })
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.findBySessionId('session-a')?.ci?.diagnostics).toEqual([
      'ci_token_unavailable:Error',
    ])
  })

  test('allows success and failed logs on demand while enforcing one shared limit without persisting traces', async () => {
    const run = createReviewRun('session-a', 3, 10, 'head-a')
    const calls: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/merge_requests/10/pipelines')) {
        return Response.json([{ id: 55, sha: 'head-a', status: 'success' }])
      }
      if (url.includes('/pipelines/55/jobs')) {
        return Response.json([
          { id: 56, name: 'build', status: 'success' },
          { id: 57, name: 'test', status: 'failed' },
        ])
      }
      if (url.includes('/jobs/56/trace')) return new Response('success trace')
      if (url.includes('/jobs/57/trace')) return new Response('token=secret-value\nfailed trace')
      throw new Error(`unexpected request: ${url}`)
    }) as typeof fetch

    await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'list' },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const successLog = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const failedLog = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 57 },
      platforms,
      secrets,
      fetch: fetchMock,
    })
    const overLimit = await inspectGitLabCiForSession({
      sessionId: 'session-a',
      request: { action: 'read_job_log', jobId: 56 },
      platforms,
      secrets,
      fetch: fetchMock,
    })

    expect(successLog).toMatchObject({
      ok: true,
      action: 'read_job_log',
      job: { id: 56, status: 'success' },
      trace: 'success trace',
    })
    expect(failedLog).toMatchObject({
      ok: true,
      action: 'read_job_log',
      job: { id: 57, status: 'failed' },
      trace: 'token=***\nfailed trace',
    })
    expect(overLimit).toEqual({
      ok: false,
      action: 'read_job_log',
      diagnostic: 'ci_job_log_limit_reached',
    })
    expect(calls.filter((url) => url.includes('/trace'))).toHaveLength(2)

    const stored = ReviewRunStore.get(run.id)
    expect(stored?.ci).toMatchObject({
      pipeline: { id: 55, sha: 'head-a' },
      diagnostics: [],
      queryCount: 1,
      jobLogReadCount: 2,
      queriedJobIds: [56, 57],
    })
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain('success trace')
    expect(serialized).not.toContain('failed trace')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('server-side-token')
  })
})

function createReviewRun(sessionId: string, projectId: number, mrIid: number, headSha: string) {
  return ReviewRunStore.create({
    platform: 'gitlab',
    status: 'running',
    sessionId,
    trigger: {
      host: 'gitlab.example.com',
      projectId,
      projectPath: 'root/uftest',
      objectType: 'mr',
      objectIid: mrIid,
      headSha,
      mode: 'webhook',
    },
    project: {
      id: 'uftest',
      host: 'gitlab.example.com',
      projectId,
      nine1botProjectID: 'project-uf',
      pathWithNamespace: 'root/uftest',
      enabled: true,
      reviewFocus: [],
      includePathPrefixes: [],
      excludePathPatterns: [],
      ci: {
        enabled: false,
        includeFailedJobLogs: false,
        maxFailedJobs: 2,
        maxJobLogBytes: 80,
      },
      source: 'configured',
      matchedAt: 1,
    },
  })
}
