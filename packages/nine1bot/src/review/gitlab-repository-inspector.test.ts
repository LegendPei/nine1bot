import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import {
  inspectGitLabRepositoryForSession,
  type GitLabRepositorySessionRequest,
} from './gitlab-repository-inspector'
import { ReviewRunStore } from './run-store'

const frozenHead = 'a'.repeat(40)
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

describe('GitLab review repository inspector', () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nine1bot-repository-inspector-store-'))
    tempDirs.push(dir)
    ReviewRunStore.setPathForTesting(join(dir, 'review-runs.json'))
    ReviewRunStore.clearForTesting()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('reads the frozen GitLab repository without requiring a Git-backed Nine1Bot Project directory', async () => {
    createReviewRun('session-frozen')
    const requests: URL[] = []

    const result = await inspectGitLabRepositoryForSession({
      sessionId: 'session-frozen',
      request: {
        action: 'read_file',
        path: 'src/app.ts',
        host: 'evil.example.com',
        projectId: 999,
        ref: 'b'.repeat(40),
        token: 'model-token',
      } as GitLabRepositorySessionRequest,
      platforms,
      secrets,
      fetch: (async (input, init) => {
        const url = new URL(String(input))
        requests.push(url)
        expect(new Headers(init?.headers).get('private-token')).toBe('server-side-token')
        return new Response('frozen value\nneedle at frozen head\n')
      }) as typeof fetch,
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'read_file',
      headSha: frozenHead,
      path: 'src/app.ts',
      content: 'frozen value\nneedle at frozen head\n',
      startLine: 1,
      endLine: 2,
      truncated: false,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.host).toBe('gitlab.example.com')
    expect(requests[0]!.pathname).toBe('/api/v4/projects/3/repository/files/src%2Fapp.ts/raw')
    expect(requests[0]!.searchParams.get('ref')).toBe(frozenHead)
    expect(requests[0]!.href).not.toContain('evil.example.com')
    expect(requests[0]!.href).not.toContain('model-token')
  })

  test('uses the frozen commit SHA for commit review repository reads', async () => {
    const commitSha = 'c'.repeat(40)
    createReviewRun('session-commit', { objectType: 'commit', sha: commitSha })
    const requestedRefs: Array<string | null> = []

    const result = await inspectRepository('session-commit', {
      action: 'read_file',
      path: 'src/commit.ts',
    }, (async (input) => {
      requestedRefs.push(new URL(String(input)).searchParams.get('ref'))
      return new Response('commit value\n')
    }) as typeof fetch)

    expect(result).toMatchObject({
      ok: true,
      action: 'read_file',
      headSha: commitSha,
      content: 'commit value\n',
    })
    expect(requestedRefs).toEqual([commitSha])
  })

  test('rejects profile-excluded and blacklisted paths before making a GitLab request', async () => {
    const run = createReviewRun('session-policy', {
      excludePathPatterns: ['secrets/**'],
    })
    let fetchCalls = 0
    const fetchMock = (async () => {
      fetchCalls += 1
      return new Response('must not be read')
    }) as unknown as typeof fetch

    const excluded = await inspectRepository('session-policy', {
      action: 'read_file',
      path: 'secrets/token.txt',
    }, fetchMock)
    const blacklisted = await inspectRepository('session-policy', {
      action: 'read_file',
      path: 'dist/bundle.js',
    }, fetchMock)
    const excludedSearch = await inspectRepository('session-policy', {
      action: 'search_text',
      query: 'token',
      pathPrefix: 'secrets',
    }, fetchMock)

    expect(excluded).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_path_excluded' })
    expect(blacklisted).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_path_blacklisted' })
    expect(excludedSearch).toEqual({ ok: false, action: 'search_text', diagnostic: 'repository_path_excluded' })
    expect(fetchCalls).toBe(0)
    expect(ReviewRunStore.get(run.id)?.repository).toMatchObject({ queryCount: 0 })
  })

  test('filters excluded search candidates before reading and again before returning matches', async () => {
    createReviewRun('session-search', {
      excludePathPatterns: ['secrets/**'],
    })
    const requestedPaths: string[] = []
    const fetchMock = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/repository/tree')) {
        expect(url.searchParams.get('ref')).toBe(frozenHead)
        expect(url.searchParams.get('recursive')).toBe('true')
        return Response.json([
          { id: '1', name: 'app.ts', type: 'blob', path: 'src/app.ts', mode: '100644' },
          { id: '2', name: 'token.ts', type: 'blob', path: 'secrets/token.ts', mode: '100644' },
          { id: '3', name: 'bundle.js', type: 'blob', path: 'dist/bundle.js', mode: '100644' },
        ])
      }
      requestedPaths.push(url.pathname)
      if (url.pathname.includes('src%2Fapp.ts')) {
        return new Response('first line\nneedle in allowed source\n')
      }
      throw new Error(`excluded path was read: ${url}`)
    }) as unknown as typeof fetch

    const result = await inspectRepository('session-search', {
      action: 'search_text',
      query: 'needle',
    }, fetchMock)

    expect(result).toMatchObject({
      ok: true,
      action: 'search_text',
      headSha: frozenHead,
      matches: [{ path: 'src/app.ts', line: 2, text: 'needle in allowed source' }],
      truncated: false,
    })
    expect(requestedPaths).toEqual(['/api/v4/projects/3/repository/files/src%2Fapp.ts/raw'])
    expect(JSON.stringify(result)).not.toContain('secrets/token.ts')
    expect(JSON.stringify(result)).not.toContain('dist/bundle.js')
  })

  test('fails closed before GitLab access when session, project snapshot, or token is invalid', async () => {
    let fetchCalls = 0
    const fetchMock = (async () => {
      fetchCalls += 1
      return new Response('unexpected')
    }) as unknown as typeof fetch

    const unbound = await inspectRepository('unknown-session', {
      action: 'read_file', path: 'src/app.ts',
    }, fetchMock)
    createReviewRun('session-mismatch', { projectHost: 'other.example.com' })
    const mismatch = await inspectRepository('session-mismatch', {
      action: 'read_file', path: 'src/app.ts',
    }, fetchMock)
    createReviewRun('session-token')
    const missingToken = await inspectGitLabRepositoryForSession({
      sessionId: 'session-token',
      request: { action: 'read_file', path: 'src/app.ts' },
      platforms,
      secrets: { ...secrets, async get() { return undefined } },
      fetch: fetchMock,
    })

    expect(unbound).toEqual({ ok: false, action: 'read_file', diagnostic: 'gitlab_review_session_not_bound' })
    expect(mismatch).toEqual({ ok: false, action: 'read_file', diagnostic: 'gitlab_review_project_snapshot_missing' })
    expect(missingToken).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_token_missing' })
    expect(fetchCalls).toBe(0)
  })

  test('rejects invalid, binary, missing, and oversized repository files with stable diagnostics', async () => {
    createReviewRun('session-invalid-files')
    let fetchCalls = 0
    const traversal = await inspectRepository('session-invalid-files', {
      action: 'read_file', path: '../outside-secret.txt',
    }, (async () => {
      fetchCalls += 1
      return new Response('unexpected')
    }) as unknown as typeof fetch)
    const binary = await inspectRepository('session-invalid-files', {
      action: 'read_file', path: 'src/binary.dat',
    }, (async () => new Response(new Uint8Array([0, 1, 2]))) as unknown as typeof fetch)
    const missing = await inspectRepository('session-invalid-files', {
      action: 'read_file', path: 'src/missing.ts',
    }, (async () => new Response('upstream details', { status: 404 })) as unknown as typeof fetch)
    const oversized = await inspectRepository('session-invalid-files', {
      action: 'read_file', path: 'src/huge.ts',
    }, (async () => new Response('x'.repeat(256 * 1024 + 2))) as unknown as typeof fetch)

    expect(traversal).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_path_invalid' })
    expect(binary).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_file_binary' })
    expect(missing).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_file_not_found' })
    expect(oversized).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_file_too_large' })
    expect(fetchCalls).toBe(0)
    expect(JSON.stringify(missing)).not.toContain('upstream details')
  })

  test('bounds per-call output and the total number of repository queries', async () => {
    const run = createReviewRun('session-budget')
    const largeSource = Array.from({ length: 400 }, (_, index) => `${index}: ${'x'.repeat(120)}`).join('\n')
    const fetchMock = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/repository/tree')) return Response.json([])
      return new Response(largeSource)
    }) as unknown as typeof fetch

    const first = await inspectRepository('session-budget', {
      action: 'read_file', path: 'src/large.ts', maxLines: 200,
    }, fetchMock)
    expect(first).toMatchObject({ ok: true, action: 'read_file', truncated: true })
    if (!first.ok || first.action !== 'read_file') throw new Error('expected bounded file output')
    expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(20 * 1024)

    const repositoryBudget = ReviewRunStore.get(run.id)?.repository
    if (!repositoryBudget) throw new Error('expected repository budget state')
    ReviewRunStore.update(run.id, { repository: { ...repositoryBudget, queryCount: 11 } })
    const finalAllowed = await inspectRepository('session-budget', {
      action: 'search_text', query: 'not-present',
    }, fetchMock)
    expect(finalAllowed.ok).toBe(true)
    const exhausted = await inspectRepository('session-budget', {
      action: 'read_file', path: 'src/large.ts',
    }, fetchMock)

    expect(exhausted).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_query_limit_reached' })
    expect(ReviewRunStore.get(run.id)?.repository).toMatchObject({ queryCount: 12 })
  })

  test('stops aborted and superseded review attempts before repository access', async () => {
    createReviewRun('session-old', { triggerKey: 'same-trigger' })
    createReviewRun('session-new', { triggerKey: 'same-trigger' })
    createReviewRun('session-aborted', { triggerKey: 'aborted-trigger' })
    let fetchCalls = 0
    const fetchMock = (async () => {
      fetchCalls += 1
      return new Response('unexpected')
    }) as unknown as typeof fetch
    const abortedController = new AbortController()
    abortedController.abort()

    const stale = await inspectRepository('session-old', {
      action: 'read_file', path: 'src/app.ts',
    }, fetchMock)
    const aborted = await inspectGitLabRepositoryForSession({
      sessionId: 'session-aborted',
      request: { action: 'read_file', path: 'src/app.ts' },
      platforms,
      secrets,
      fetch: fetchMock,
      signal: abortedController.signal,
    })

    expect(stale).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_review_attempt_stale' })
    expect(aborted).toEqual({ ok: false, action: 'read_file', diagnostic: 'repository_request_aborted' })
    expect(fetchCalls).toBe(0)
  })
})

async function inspectRepository(
  sessionId: string,
  request: GitLabRepositorySessionRequest,
  fetch: typeof globalThis.fetch,
) {
  return await inspectGitLabRepositoryForSession({ sessionId, request, platforms, secrets, fetch })
}

function createReviewRun(
  sessionId: string,
  options: {
    excludePathPatterns?: string[]
    objectType?: 'mr' | 'commit'
    projectHost?: string
    sha?: string
    triggerKey?: string
  } = {},
) {
  return ReviewRunStore.create({
    platform: 'gitlab',
    status: 'running',
    sessionId,
    ...(options.triggerKey ? { triggerKey: options.triggerKey } : {}),
    trigger: {
      host: 'gitlab.example.com',
      projectId: 3,
      projectPath: 'root/uftest',
      ...(options.objectType === 'commit'
        ? { objectType: 'commit' as const, commitSha: options.sha ?? frozenHead }
        : { objectType: 'mr' as const, objectIid: 10, headSha: options.sha ?? frozenHead }),
      mode: 'webhook',
    },
    project: {
      id: 'uftest',
      host: options.projectHost ?? 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      pathWithNamespace: 'root/uftest',
      enabled: true,
      reviewFocus: [],
      includePathPrefixes: [],
      excludePathPatterns: options.excludePathPatterns ?? [],
      ci: { maxJobLogs: 2, maxJobLogBytes: 80 },
      source: 'configured',
      matchedAt: 1,
    },
    repository: {
      queryCount: 0,
      readCount: 0,
      searchCount: 0,
      outputBytes: 0,
    },
  })
}
