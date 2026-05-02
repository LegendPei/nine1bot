import { beforeEach, describe, expect, test } from 'bun:test'
import {
  extractGitLabReviewStageResultFromRuntimeText,
  handleGitLabReviewWebhook,
  publishGitLabReviewRunResult,
} from './gitlab-controller'
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

  test('extracts runtime review results from fenced output', () => {
    const extracted = extractGitLabReviewStageResultFromRuntimeText([
      'Review complete.',
      '```json',
      'GITLAB_REVIEW_RESULT:',
      JSON.stringify({
        stage: 'verification',
        status: 'ok',
        summary: 'No blocking findings.',
        findings: [],
      }),
      '```',
    ].join('\n'))

    expect(extracted).toEqual({
      stage: 'verification',
      status: 'ok',
      summary: 'No blocking findings.',
      findings: [],
    })
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

  test('publishes runtime stage results through GitLab publisher', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/changes')) {
        return Response.json({
          diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'publish-sha' },
          changes: [{
            old_path: 'src/app.ts',
            new_path: 'src/app.ts',
            diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
          }],
        })
      }
      return Response.json({ id: 1 })
    }) as typeof fetch

    const accepted = await handleGitLabReviewWebhook({
      payload: {
        object_kind: 'merge_request',
        project: {
          id: 123,
          web_url: 'https://gitlab.example.com/nine1/nine1bot',
        },
        object_attributes: {
          iid: 10,
          last_commit: { id: 'publish-sha' },
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

    expect(accepted).toMatchObject({ accepted: true, status: 'accepted' })
    if (!accepted.accepted) throw new Error('expected accepted review run')

    const published = await publishGitLabReviewRunResult({
      runId: accepted.runId,
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
      stageResult: {
        stage: 'verification',
        status: 'ok',
        summary: 'Runtime review complete.',
        findings: [{
          title: 'Changed line',
          body: 'Inline body',
          severity: 'major',
          file: 'src/app.ts',
          newLine: 2,
        }],
      },
    })

    expect(published).toMatchObject({
      published: true,
      inlinePosted: 1,
      fallbackPosted: 0,
    })
    await expect(publishGitLabReviewRunResult({
      runId: accepted.runId,
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
      stageResult: {
        stage: 'verification',
        status: 'ok',
        summary: 'Duplicate publish.',
        findings: [],
      },
    })).resolves.toMatchObject({
      published: false,
      error: 'review_run_already_published',
    })
    expect(calls.map((call) => call.url)).toEqual([
      'https://gitlab.example.com/api/v4/projects/123/merge_requests/10/changes',
      'https://gitlab.example.com/api/v4/projects/123/merge_requests/10/discussions',
      'https://gitlab.example.com/api/v4/projects/123/merge_requests/10/notes',
    ])
  })

  test('loads live commit diff and publishes a commit summary comment', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('/diff')) {
        return Response.json([{
          old_path: 'src/commit.ts',
          new_path: 'src/commit.ts',
          diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
        }])
      }
      return Response.json({ id: 1 })
    }) as typeof fetch

    const accepted = await handleGitLabReviewWebhook({
      payload: {
        object_kind: 'note',
        project: {
          id: 123,
          web_url: 'https://gitlab.example.com/nine1/nine1bot',
        },
        object_attributes: {
          id: 99,
          note: '@Nine1bot review commit',
        },
        commit: {
          id: 'commit-sha',
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

    expect(accepted).toMatchObject({
      accepted: true,
      status: 'accepted',
      idempotencyKey: 'gitlab:gitlab.example.com:123:commit:commit-sha:note:99',
    })
    if (!accepted.accepted) throw new Error('expected accepted commit review run')

    const published = await publishGitLabReviewRunResult({
      runId: accepted.runId,
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
      stageResult: {
        stage: 'verification',
        status: 'ok',
        summary: 'Commit review complete.',
        findings: [{
          title: 'Changed line',
          body: 'Commit finding body',
          severity: 'major',
          file: 'src/commit.ts',
          newLine: 2,
        }],
      },
    })

    expect(published).toMatchObject({
      published: true,
      inlinePosted: 0,
      fallbackPosted: 0,
    })
    expect(calls.map((call) => call.url)).toEqual([
      'https://gitlab.example.com/api/v4/projects/123/repository/commits/commit-sha/diff',
      'https://gitlab.example.com/api/v4/projects/123/repository/commits/commit-sha/comments',
    ])
    expect(String(calls[1]?.init?.body)).toContain('note=')
  })
})
