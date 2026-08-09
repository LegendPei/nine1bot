import {
  GitLabApiClient,
  inspectGitLabCi,
  normalizeGitLabAuthority,
  normalizeGitLabReviewSettings,
  readGitLabCiJobLog,
  resolveGitLabApiBaseUrl,
  type GitLabPipelineJob,
  type GitLabPipelineSummary,
} from '@nine1bot/platform-gitlab/review'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import type { PlatformManagerConfig } from '../platform/manager'
import { ReviewRunStore, type ReviewRunCiSummary, type ReviewRunRecord } from './run-store'

export type GitLabCiSessionRequest =
  | { action: 'list' }
  | { action: 'read_job_log'; jobId: number }

type GitLabCiTarget = {
  host: string
  projectId: string | number
  mrIid: string | number
  headSha: string
  mrUrl?: string
}

export type GitLabCiToolOutput =
  | {
      ok: true
      action: 'list'
      observedAt: number
      target: GitLabCiTarget
      pipeline?: GitLabPipelineSummary
      jobs: GitLabPipelineJob[]
      diagnostics: string[]
    }
  | {
      ok: true
      action: 'read_job_log'
      observedAt: number
      target: GitLabCiTarget
      job: GitLabPipelineJob
      trace: string
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: false
      action: GitLabCiSessionRequest['action']
      diagnostic: string
    }

export async function inspectGitLabCiForSession(input: {
  sessionId: string
  request: GitLabCiSessionRequest
  platforms: PlatformManagerConfig
  secrets: PlatformSecretAccess
  fetch?: typeof fetch
}): Promise<GitLabCiToolOutput> {
  const run = ReviewRunStore.findBySessionId(input.sessionId)
  if (!run) return failure(input.request.action, 'gitlab_review_session_not_bound')

  const target = targetForRun(run)
  if (!target) return failure(input.request.action, 'gitlab_review_mr_identity_missing')
  if (!projectSnapshotMatches(run, target)) {
    return failure(input.request.action, 'gitlab_review_project_snapshot_missing')
  }

  const platform = input.platforms.gitlab
  const settings = normalizeGitLabReviewSettings(platform?.settings)
  if (!platform?.enabled || !settings.enabled) {
    return failure(input.request.action, 'gitlab_review_not_configured')
  }

  const resolvedBaseUrl = resolveGitLabApiBaseUrl({
    configuredBaseUrl: settings.baseUrl,
    triggerHost: target.host,
  })
  if (!resolvedBaseUrl.ok) return failure(input.request.action, resolvedBaseUrl.reason)

  let token: string | undefined
  try {
    token = await resolveSecret(settings.tokenSecretRef, input.secrets)
  } catch (error) {
    const diagnostic = `ci_token_unavailable:${errorName(error)}`
    recordDiagnostic(run.id, diagnostic, input.request.action === 'list')
    return failure(input.request.action, diagnostic)
  }
  if (!token) {
    recordDiagnostic(run.id, 'ci_token_missing', input.request.action === 'list')
    return failure(input.request.action, 'ci_token_missing')
  }

  const client = new GitLabApiClient({
    baseUrl: resolvedBaseUrl.baseUrl,
    token,
    fetch: input.fetch,
  })

  if (input.request.action === 'list') {
    const result = await inspectGitLabCi({
      client,
      projectId: target.projectId,
      mrIid: target.mrIid,
      headSha: target.headSha,
    })
    const observedAt = Date.now()
    updateCiSummary(run.id, (current) => ({
      ...current,
      pipeline: result.pipeline,
      diagnostics: mergeDiagnostics(current.diagnostics, result.diagnostics),
      observedAt,
      queryCount: (current.queryCount ?? 0) + 1,
    }))
    return {
      ok: true,
      action: 'list',
      observedAt,
      target: { ...target, mrUrl: mergeRequestUrl(resolvedBaseUrl.baseUrl, run, target) },
      pipeline: result.pipeline,
      jobs: result.jobs,
      diagnostics: result.diagnostics,
    }
  }

  const pipelineResult = await inspectGitLabCi({
    client,
    projectId: target.projectId,
    mrIid: target.mrIid,
    headSha: target.headSha,
  })
  if (!pipelineResult.pipeline) {
    const diagnostic = pipelineResult.diagnostics[0] ?? 'ci_pipeline_not_found_for_head_sha'
    recordDiagnostic(run.id, diagnostic, false)
    return failure(input.request.action, diagnostic)
  }

  const reserved = reserveJobLogRead(run.id, input.sessionId, input.request.jobId)
  if (!reserved) return failure(input.request.action, 'ci_job_log_limit_reached')

  const result = await readGitLabCiJobLog({
    client,
    projectId: target.projectId,
    pipelineId: pipelineResult.pipeline.id,
    jobId: input.request.jobId,
    maxBytes: jobLogByteLimit(run),
  })
  const observedAt = Date.now()
  updateCiSummary(run.id, (current) => ({
    ...current,
    pipeline: pipelineResult.pipeline,
    diagnostics: mergeDiagnostics(current.diagnostics, [...pipelineResult.diagnostics, ...result.diagnostics]),
    observedAt,
  }))
  if (!result.job || result.trace === undefined || result.diagnostics.length > 0) {
    return failure(input.request.action, result.diagnostics[0] ?? 'ci_job_log_unavailable')
  }
  return {
    ok: true,
    action: 'read_job_log',
    observedAt,
    target: { ...target, mrUrl: mergeRequestUrl(resolvedBaseUrl.baseUrl, run, target) },
    job: result.job,
    trace: result.trace,
    bytes: result.bytes,
    truncated: result.truncated,
    diagnostics: result.diagnostics,
  }
}

function targetForRun(run: ReviewRunRecord): GitLabCiTarget | undefined {
  const trigger = run.trigger
  if (!trigger || trigger.objectType !== 'mr') return undefined
  if (typeof trigger.host !== 'string' || !normalizeGitLabAuthority(trigger.host)) return undefined
  if (!isId(trigger.projectId) || !isId(trigger.objectIid)) return undefined
  if (typeof trigger.headSha !== 'string' || !trigger.headSha.trim()) return undefined
  return {
    host: normalizeGitLabAuthority(trigger.host)!,
    projectId: trigger.projectId,
    mrIid: trigger.objectIid,
    headSha: trigger.headSha,
  }
}

function projectSnapshotMatches(run: ReviewRunRecord, target: GitLabCiTarget) {
  if (!run.project) return false
  if (String(run.project.projectId) !== String(target.projectId)) return false
  if (!run.project.host) return false
  return normalizeGitLabAuthority(run.project.host) === target.host
}

function mergeRequestUrl(baseUrl: string, run: ReviewRunRecord, target: GitLabCiTarget) {
  const path = typeof run.trigger?.projectPath === 'string' && run.trigger.projectPath.trim()
    ? run.trigger.projectPath
    : run.project?.pathWithNamespace
  if (!path) return undefined
  const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  if (!encodedPath) return undefined
  return `${baseUrl.replace(/\/+$/, '')}/${encodedPath}/-/merge_requests/${encodeURIComponent(String(target.mrIid))}`
}

function reserveJobLogRead(runId: string, sessionId: string, jobId: number) {
  const current = ReviewRunStore.get(runId)
  if (!current || current.sessionId !== sessionId) return false
  const limit = jobLogReadLimit(current)
  const count = current.ci?.jobLogReadCount ?? 0
  if (count >= limit) return false
  ReviewRunStore.update(runId, {
    ci: {
      ...current.ci,
      diagnostics: current.ci?.diagnostics ?? [],
      jobLogReadCount: count + 1,
      queriedJobIds: [...(current.ci?.queriedJobIds ?? []), jobId],
    },
  })
  return true
}

function recordDiagnostic(runId: string, diagnostic: string, countQuery: boolean) {
  updateCiSummary(runId, (current) => ({
    ...current,
    diagnostics: mergeDiagnostics(current.diagnostics, [diagnostic]),
    observedAt: Date.now(),
    ...(countQuery ? { queryCount: (current.queryCount ?? 0) + 1 } : {}),
  }))
}

function updateCiSummary(runId: string, update: (current: ReviewRunCiSummary) => ReviewRunCiSummary) {
  const current = ReviewRunStore.get(runId)
  if (!current) return
  ReviewRunStore.update(runId, {
    ci: update(current.ci ?? { diagnostics: [] }),
  })
}

function jobLogReadLimit(run: ReviewRunRecord) {
  const configured = run.project?.ci.maxJobLogs
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 3
}

function jobLogByteLimit(run: ReviewRunRecord) {
  const configured = run.project?.ci.maxJobLogBytes
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : 8_000
}

async function resolveSecret(
  ref: string | PlatformSecretRef | undefined,
  secrets: PlatformSecretAccess,
) {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref)
}

function mergeDiagnostics(current: string[], additions: string[]) {
  return [...new Set([...current, ...additions])]
}

function isId(input: unknown): input is string | number {
  return (typeof input === 'string' && input.length > 0)
    || (typeof input === 'number' && Number.isFinite(input))
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

function failure(action: GitLabCiSessionRequest['action'], diagnostic: string): GitLabCiToolOutput {
  return { ok: false, action, diagnostic }
}
