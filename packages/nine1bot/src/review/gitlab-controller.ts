import {
  buildGitLabReviewContext,
  buildGitLabReviewIdempotencyKey,
  normalizeGitLabReviewSettings,
  parseGitLabWebhookEvent,
  validateGitLabWebhookToken,
  type GitLabRawChangesResponse,
  type GitLabReviewSecretRef,
  type GitLabReviewSettings,
  type GitLabReviewTrigger,
} from '@nine1bot/platform-gitlab/review'
import type { PlatformManagerConfig } from '../platform/manager'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'

export type GitLabReviewWebhookInput = {
  payload: unknown
  headers: Record<string, string | undefined>
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
}

export type GitLabReviewWebhookResult =
  | {
      accepted: true
      status: 'accepted' | 'dry-run'
      idempotencyKey: string
      trigger: GitLabReviewTrigger
      context?: ReturnType<typeof buildGitLabReviewContext>
      warnings: string[]
    }
  | {
      accepted: false
      status: 'rejected'
      error: string
      httpStatus: number
    }

export async function handleGitLabReviewWebhook(input: GitLabReviewWebhookInput): Promise<GitLabReviewWebhookResult> {
  const settings = normalizeGitLabReviewSettings(input.platforms.gitlab?.settings)
  if (!settings.enabled) {
    return reject(403, 'gitlab_review_disabled')
  }

  const expectedSecret = await resolveGitLabReviewSecret(settings.webhookSecretRef, input.secrets)
  const tokenValidation = validateGitLabWebhookToken({
    expectedSecret,
    receivedToken: header(input.headers, 'x-gitlab-token'),
  })
  if (!tokenValidation.ok) {
    return reject(401, tokenValidation.reason ?? 'invalid_gitlab_webhook_token')
  }

  const parsed = parseGitLabWebhookEvent(input.payload, settings)
  if (!parsed.ok) {
    return reject(202, parsed.reason)
  }

  const idempotencyKey = buildGitLabReviewIdempotencyKey(parsed.trigger)
  const fixtureChanges = extractDryRunChanges(input.payload)
  if (settings.dryRun && fixtureChanges) {
    return {
      accepted: true,
      status: 'dry-run',
      idempotencyKey,
      trigger: parsed.trigger,
      context: buildGitLabReviewContext({
        trigger: parsed.trigger,
        changes: fixtureChanges,
        maxDiffBytes: settings.maxDiffBytes,
        maxFiles: settings.maxFiles,
      }),
      warnings: [],
    }
  }

  return {
    accepted: true,
    status: 'accepted',
    idempotencyKey,
    trigger: parsed.trigger,
    warnings: settings.dryRun
      ? ['Dry-run payload did not include changes; live GitLab changes fetch is not wired yet.']
      : ['Runtime review execution is not wired yet.'],
  }
}

export async function resolveGitLabReviewSecret(
  ref: GitLabReviewSecretRef | undefined,
  secrets: PlatformSecretAccess,
): Promise<string | undefined> {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref satisfies PlatformSecretRef)
}

function reject(httpStatus: number, error: string): GitLabReviewWebhookResult {
  return {
    accepted: false,
    status: 'rejected',
    error,
    httpStatus,
  }
}

function header(headers: Record<string, string | undefined>, name: string) {
  const expected = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value
  }
  return undefined
}

function extractDryRunChanges(payload: unknown): GitLabRawChangesResponse | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (isRawChangesResponse(record.changes)) return record.changes
  if (isRawChangesResponse(record.review_changes)) return record.review_changes
  return undefined
}

function isRawChangesResponse(input: unknown): input is GitLabRawChangesResponse {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input))
}
