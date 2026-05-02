import {
  GitLabApiClient,
  buildGitLabReviewContext,
  buildGitLabReviewIdempotencyKey,
  parseReviewStageResult,
  publishGitLabReviewResult,
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

export type PublishGitLabReviewRunResult =
  | {
      published: true
      runId: string
      summaryPosted: boolean
      inlinePosted: number
      fallbackPosted: number
      warnings: string[]
    }
  | {
      published: false
      runId?: string
      error: string
      warnings?: string[]
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
    '',
    'At the end, emit exactly one fenced json block tagged GITLAB_REVIEW_RESULT. The JSON must match the GitLab review finding schema.',
  ].filter(Boolean).join('\n')
}

export function extractGitLabReviewStageResultFromRuntimeText(text: string): unknown | undefined {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate)
      parseReviewStageResult(parsed)
      return parsed
    } catch {
      continue
    }
  }
  return undefined
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
        context,
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
    ReviewRunStore.update(run.id, { status: settings.dryRun ? 'succeeded' : 'running', context })
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

export async function publishGitLabReviewRunResult(input: {
  runId: string
  stageResult: unknown
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
}): Promise<PublishGitLabReviewRunResult> {
  const run = ReviewRunStore.get(input.runId)
  if (!run) return { published: false, runId: input.runId, error: 'review_run_not_found' }
  if (run.publishedAt) {
    return { published: false, runId: input.runId, error: 'review_run_already_published' }
  }
  const context = run.context as ReturnType<typeof buildGitLabReviewContext> | undefined
  const trigger = run.trigger as GitLabReviewTrigger | undefined
  if (!context || !trigger) return { published: false, runId: input.runId, error: 'review_run_context_missing' }

  const settings = normalizeGitLabReviewSettings(input.platforms.gitlab?.settings)
  if (settings.dryRun) {
    const warning = 'GitLab review result publishing skipped because dry-run is enabled.'
    ReviewRunStore.update(input.runId, { status: 'succeeded', warnings: [warning] })
    return { published: false, runId: input.runId, error: 'dry_run_enabled', warnings: [warning] }
  }

  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, input.secrets)
  if (!token) {
    ReviewRunStore.update(input.runId, { status: 'failed', error: 'gitlab_token_missing' })
    return { published: false, runId: input.runId, error: 'gitlab_token_missing' }
  }

  const parsed = parseReviewStageResult(input.stageResult)
  const objectId = trigger.objectType === 'mr' ? trigger.objectIid : trigger.commitSha
  if (!objectId) {
    ReviewRunStore.update(input.runId, { status: 'failed', error: 'gitlab_review_object_missing' })
    return { published: false, runId: input.runId, error: 'gitlab_review_object_missing' }
  }

  const client = new GitLabApiClient({
    baseUrl: settings.baseUrl ?? `https://${trigger.host}`,
    token,
    fetch: input.fetch,
  })
  const published = await publishGitLabReviewResult({
    client,
    projectId: trigger.projectId,
    objectType: trigger.objectType,
    objectId,
    manifest: context.diff,
    summary: parsed.summary,
    findings: parsed.findings,
    inlineComments: settings.inlineComments,
    warnings: parsed.nextActions,
  })
  ReviewRunStore.update(input.runId, {
    status: parsed.status === 'failed' ? 'failed' : 'succeeded',
    publishedAt: Date.now(),
    warnings: published.warnings,
  })

  return {
    published: true,
    runId: input.runId,
    ...published,
  }
}

async function loadLiveChanges(input: {
  trigger: GitLabReviewTrigger
  settings: GitLabReviewSettings
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
}): Promise<GitLabRawChangesResponse | undefined> {
  if (input.settings.dryRun) return undefined
  const baseUrl = input.settings.baseUrl ?? `https://${input.trigger.host}`
  const token = await resolveGitLabReviewSecret(input.settings.tokenSecretRef, input.secrets)
  if (!token) return undefined
  const client = new GitLabApiClient({ baseUrl, token, fetch: input.fetch })
  if (input.trigger.objectType === 'mr' && input.trigger.objectIid) {
    return await client.getMergeRequestChanges(input.trigger.projectId, input.trigger.objectIid)
  }
  if (input.trigger.objectType === 'commit' && input.trigger.commitSha) {
    return await client.getCommitDiff(input.trigger.projectId, input.trigger.commitSha)
  }
  return undefined
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

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fencePattern)) {
    const content = match[1]?.trim()
    if (content) candidates.push(stripGitLabReviewResultTag(content))
  }

  const tagged = /GITLAB_REVIEW_RESULT\s*:?\s*(\{[\s\S]*\})/i.exec(text)
  if (tagged?.[1]) candidates.push(tagged[1].trim())

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim())
  }
  return [...new Set(candidates)]
}

function stripGitLabReviewResultTag(content: string) {
  return content.replace(/^GITLAB_REVIEW_RESULT\s*:?\s*/i, '').trim()
}
