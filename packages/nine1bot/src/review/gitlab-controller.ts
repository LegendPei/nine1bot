import {
  GitLabApiClient,
  buildGitLabReviewContext,
  buildGitLabReviewIdempotencyKey,
  renderBlockedDiffComment,
  normalizeGitLabReviewSettings,
  parseGitLabWebhookEvent,
  validateGitLabWebhookToken,
  type GitLabRawChangesResponse,
  type GitLabReviewSecretRef,
  type GitLabReviewSettings,
  type GitLabReviewTrigger,
} from '@nine1bot/platform-gitlab/review'
import { ReviewRunStore } from './run-store'
import type { PlatformManagerConfig } from '../platform/manager'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'

export type GitLabReviewWebhookInput = {
  payload: unknown
  headers: Record<string, string | undefined>
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
}

export type GitLabReviewWebhookResult =
  | {
      accepted: true
      status: 'accepted' | 'dry-run' | 'blocked'
      idempotencyKey: string
      runId: string
      trigger: GitLabReviewTrigger
      context?: ReturnType<typeof buildGitLabReviewContext>
      warnings: string[]
      duplicateOf?: string
    }
  | {
      accepted: false
      status: 'rejected'
      error: string
      httpStatus: number
      runId?: string
    }

export function buildGitLabReviewRuntimePrompt(input: {
  idempotencyKey: string
  trigger: GitLabReviewTrigger
  context: ReturnType<typeof buildGitLabReviewContext>
}) {
  return [
    'Run GitLab code review workflow.',
    '',
    `Idempotency key: ${input.idempotencyKey}`,
    `Trigger: ${input.trigger.mode}`,
    `Object: ${input.trigger.objectType}`,
    input.trigger.objectIid ? `MR IID: ${input.trigger.objectIid}` : undefined,
    input.trigger.commitSha ? `Commit SHA: ${input.trigger.commitSha}` : undefined,
    input.trigger.headSha ? `Head SHA: ${input.trigger.headSha}` : undefined,
    '',
    'Use the declared GitLab review skills. Produce structured review findings only from the supplied diff context. If an inline position is uncertain, prefer a top-level finding without a guessed line.',
  ].filter(Boolean).join('\n')
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
  const duplicate = ReviewRunStore.findByIdempotencyKey(idempotencyKey)
  if (duplicate && duplicate.status !== 'failed') {
    return {
      accepted: true,
      status: 'accepted',
      idempotencyKey,
      runId: duplicate.id,
      trigger: parsed.trigger,
      warnings: ['Duplicate GitLab review trigger ignored by idempotency key.'],
      duplicateOf: duplicate.id,
    }
  }

  const run = ReviewRunStore.create({
    platform: 'gitlab',
    idempotencyKey,
    status: 'accepted',
    trigger: parsed.trigger as unknown as Record<string, unknown>,
  })

  const fixtureChanges = extractDryRunChanges(input.payload)
  const changes = fixtureChanges ?? await loadLiveChanges({
    trigger: parsed.trigger,
    settings,
    secrets: input.secrets,
    fetch: input.fetch,
  })

  if (changes) {
    const context = buildGitLabReviewContext({
      trigger: parsed.trigger,
      changes,
      maxDiffBytes: settings.maxDiffBytes,
      maxFiles: settings.maxFiles,
    })
    if (context.diff.blocked) {
      await maybeWriteBlockedComment({
        trigger: parsed.trigger,
        settings,
        secrets: input.secrets,
        fetch: input.fetch,
        reason: context.diff.blockReason ?? 'MR diff is too large or was truncated by GitLab.',
      })
      ReviewRunStore.update(run.id, {
        status: 'blocked',
        warnings: [context.diff.blockReason ?? 'GitLab diff blocked.'],
      })
      return {
        accepted: true,
        status: 'blocked',
        idempotencyKey,
        runId: run.id,
        trigger: parsed.trigger,
        context,
        warnings: [context.diff.blockReason ?? 'GitLab diff blocked.'],
      }
    }
    ReviewRunStore.update(run.id, { status: settings.dryRun ? 'succeeded' : 'running' })
    return {
      accepted: true,
      status: settings.dryRun ? 'dry-run' : 'accepted',
      idempotencyKey,
      runId: run.id,
      trigger: parsed.trigger,
      context,
      warnings: [],
    }
  }

  ReviewRunStore.update(run.id, {
    status: settings.dryRun ? 'succeeded' : 'running',
    warnings: settings.dryRun
      ? ['Dry-run payload did not include changes; live GitLab changes fetch is not wired for this trigger.']
      : ['Runtime review execution is not wired yet.'],
  })
  return {
    accepted: true,
    status: 'accepted',
    idempotencyKey,
    runId: run.id,
    trigger: parsed.trigger,
    warnings: settings.dryRun
      ? ['Dry-run payload did not include changes; live GitLab changes fetch is not wired yet.']
      : ['Runtime review execution is not wired yet.'],
  }
}

async function loadLiveChanges(input: {
  trigger: GitLabReviewTrigger
  settings: GitLabReviewSettings
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
}): Promise<GitLabRawChangesResponse | undefined> {
  if (input.trigger.objectType !== 'mr') return undefined
  if (input.settings.dryRun) return undefined
  const baseUrl = input.settings.baseUrl ?? `https://${input.trigger.host}`
  const token = await resolveGitLabReviewSecret(input.settings.tokenSecretRef, input.secrets)
  if (!token || !input.trigger.objectIid) return undefined
  const client = new GitLabApiClient({ baseUrl, token, fetch: input.fetch })
  return await client.getMergeRequestChanges(input.trigger.projectId, input.trigger.objectIid)
}

async function maybeWriteBlockedComment(input: {
  trigger: GitLabReviewTrigger
  settings: GitLabReviewSettings
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
  reason: string
}) {
  if (input.settings.dryRun || input.trigger.objectType !== 'mr' || !input.trigger.objectIid) return
  const token = await resolveGitLabReviewSecret(input.settings.tokenSecretRef, input.secrets)
  if (!token) return
  const baseUrl = input.settings.baseUrl ?? `https://${input.trigger.host}`
  const client = new GitLabApiClient({ baseUrl, token, fetch: input.fetch })
  await client.createNote({
    projectId: input.trigger.projectId,
    resource: 'merge_requests',
    resourceId: input.trigger.objectIid,
    body: renderBlockedDiffComment(input.reason),
  })
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
  const run = ReviewRunStore.create({
    platform: 'gitlab',
    status: 'rejected',
    error,
  })
  return {
    accepted: false,
    status: 'rejected',
    error,
    httpStatus,
    runId: run.id,
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
