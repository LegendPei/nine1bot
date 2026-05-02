import { describe, expect, test } from 'bun:test'
import { handleGitLabReviewWebhook } from './gitlab-controller'
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
})
