import { beforeEach, describe, expect, test } from 'bun:test'
import { handleGitLabReviewWebhook } from './gitlab-controller'
import { ReviewRunStore } from './run-store'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'

const memorySecrets: PlatformSecretAccess = {
  async get(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-webhook' ? 'secret' : undefined
  },
  async set() {},
  async delete() {},
  async has(ref: PlatformSecretRef) {
    return ref.key === 'gitlab-webhook'
  },
}

const liveSecrets: PlatformSecretAccess = {
  async get(ref: PlatformSecretRef) {
    if (ref.key === 'gitlab-webhook') return 'secret'
    if (ref.key === 'gitlab-token') return 'token'
    return undefined
  },
  async set() {},
  async delete() {},
  async has() {
    return true
  },
}

const platforms = {
  gitlab: {
    enabled: true,
    settings: {
      'review.enabled': true,
      'review.webhookSecretRef': {
        provider: 'nine1bot-local',
        key: 'gitlab-webhook',
      },
      'review.tokenSecretRef': {
        provider: 'nine1bot-local',
        key: 'gitlab-token',
      },
      'review.dryRun': true,
      'review.webhookAutoReview': true,
      allowedHosts: ['gitlab.example.com'],
      'review.allowedProjectIds': ['123'],
    },
  },
}

describe('GitLab review controller', () => {
  beforeEach(() => {
    ReviewRunStore.clearForTesting()
  })

  test('rejects disabled GitLab review', async () => {
    await expect(handleGitLabReviewWebhook({
      payload: {},
      headers: {},
      platforms: {
        gitlab: {
          enabled: true,
          settings: {
            'review.enabled': false,
          },
        },
      },
      secrets: memorySecrets,
    })).resolves.toMatchObject({
      accepted: false,
      httpStatus: 403,
      error: 'gitlab_review_disabled',
    })
  })

  test('rejects invalid GitLab webhook token', async () => {
    await expect(handleGitLabReviewWebhook({
      payload: {},
      headers: { 'x-gitlab-token': 'wrong' },
      platforms,
      secrets: memorySecrets,
    })).resolves.toMatchObject({
      accepted: false,
      httpStatus: 401,
      error: 'invalid-x-gitlab-token',
    })
  })

  test('accepts merge request webhook and builds dry-run context when changes are supplied', async () => {
    const result = await handleGitLabReviewWebhook({
      payload: {
        object_kind: 'merge_request',
        project: {
          id: 123,
          path_with_namespace: 'nine1/nine1bot',
          web_url: 'https://gitlab.example.com/nine1/nine1bot',
        },
        object_attributes: {
          iid: 10,
          last_commit: { id: 'abc123' },
        },
        changes: {
          changes: [
            { old_path: 'src/app.ts', new_path: 'src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
          ],
        },
      },
      headers: { 'x-gitlab-token': 'secret' },
      platforms,
      secrets: memorySecrets,
    })

    expect(result).toMatchObject({
      accepted: true,
      status: 'dry-run',
      idempotencyKey: 'gitlab:gitlab.example.com:123:mr:10:head_sha:abc123:auto:merge_request',
    })
    expect(result.accepted && result.context?.diff.stats.includedFileCount).toBe(1)
  })

  test('deduplicates accepted review triggers by idempotency key', async () => {
    const payload = {
      object_kind: 'merge_request',
      project: {
        id: 123,
        path_with_namespace: 'nine1/nine1bot',
        web_url: 'https://gitlab.example.com/nine1/nine1bot',
      },
      object_attributes: {
        iid: 10,
        last_commit: { id: 'abc123' },
      },
    }

    const first = await handleGitLabReviewWebhook({
      payload,
      headers: { 'x-gitlab-token': 'secret' },
      platforms,
      secrets: memorySecrets,
    })
    const second = await handleGitLabReviewWebhook({
      payload,
      headers: { 'x-gitlab-token': 'secret' },
      platforms,
      secrets: memorySecrets,
    })

    expect(first.accepted && second.accepted && second.duplicateOf).toBe(first.accepted && first.runId)
  })

  test('loads live MR changes and writes blocked comments for overflow diffs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/changes')) {
        return Response.json({
          overflow: true,
          changes: [{ old_path: 'src/large.ts', new_path: 'src/large.ts', diff: '', overflow: true }],
        })
      }
      return Response.json({ id: 1 })
    }) as typeof fetch

    const result = await handleGitLabReviewWebhook({
      payload: {
        object_kind: 'merge_request',
        project: {
          id: 123,
          web_url: 'https://gitlab.example.com/nine1/nine1bot',
        },
        object_attributes: {
          iid: 10,
          last_commit: { id: 'overflow-sha' },
        },
      },
      headers: { 'x-gitlab-token': 'secret' },
      platforms: {
        gitlab: {
          enabled: true,
          settings: {
            ...platforms.gitlab?.settings,
            'review.dryRun': false,
            'review.baseUrl': 'https://gitlab.example.com',
          },
        },
      },
      secrets: liveSecrets,
      fetch: fetchMock,
    })

    expect(result).toMatchObject({
      accepted: true,
      status: 'blocked',
      idempotencyKey: 'gitlab:gitlab.example.com:123:mr:10:head_sha:overflow-sha:auto:merge_request',
    })
    expect(calls.map((call) => call.url)).toEqual([
      'https://gitlab.example.com/api/v4/projects/123/merge_requests/10/changes',
      'https://gitlab.example.com/api/v4/projects/123/merge_requests/10/notes',
    ])
  })
})
