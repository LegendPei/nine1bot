import type { GitLabApiClient, GitLabPipelineJob, GitLabPipelineSummary } from './api-client'

export const MAX_GITLAB_CI_JOBS = 100
export const MAX_GITLAB_CI_LIST_BYTES = 32 * 1024
export const MAX_GITLAB_CI_JOB_LOG_BYTES = 16 * 1024

export type GitLabCiPipeline = {
  id: number
  iid?: number
  projectId?: number
  status?: string
  source?: string
  sha?: string
  ref?: string
  webUrl?: string
  createdAt?: string
  updatedAt?: string
}

export type GitLabCiJob = {
  id: number
  name?: string
  stage?: string
  status?: string
  allowFailure?: boolean
  webUrl?: string
  startedAt?: string | null
  finishedAt?: string | null
  duration?: number | null
}

export type GitLabCiListResult = {
  pipeline?: GitLabCiPipeline
  jobs: GitLabCiJob[]
  diagnostics: string[]
  truncated: boolean
  totalJobs: number
  returnedJobs: number
}

export type GitLabCiJobLogResult = {
  job?: GitLabCiJob
  trace?: string
  bytes: number
  truncated: boolean
  diagnostics: string[]
}

export async function inspectGitLabCi(input: {
  client: Pick<GitLabApiClient, 'getMergeRequestPipelines' | 'getPipelineJobs'>
  projectId: string | number
  mrIid: string | number
  headSha: string
  signal?: AbortSignal
}): Promise<GitLabCiListResult> {
  let pipelines: GitLabPipelineSummary[]
  try {
    pipelines = await input.client.getMergeRequestPipelines(input.projectId, input.mrIid, { signal: input.signal })
  } catch (error) {
    return emptyListResult(`ci_pipeline_unavailable:${errorName(error)}`)
  }
  const rawPipeline = pipelines.find((candidate) => candidate.sha === input.headSha)
  if (!rawPipeline) return emptyListResult('ci_pipeline_not_found_for_head_sha')
  const pipeline = projectCiPipeline(rawPipeline)
  try {
    const jobs = await input.client.getPipelineJobs(input.projectId, rawPipeline.id, { signal: input.signal })
    return boundCiList(pipeline, jobs.map(projectCiJob), [])
  } catch (error) {
    return {
      pipeline,
      jobs: [],
      diagnostics: [`ci_jobs_unavailable:${errorName(error)}`],
      truncated: false,
      totalJobs: 0,
      returnedJobs: 0,
    }
  }
}

export async function readGitLabCiJobLog(input: {
  client: Pick<GitLabApiClient, 'getPipelineJobs' | 'getJobTrace'>
  projectId: string | number
  pipelineId: string | number
  jobId: string | number
  maxBytes: number
  signal?: AbortSignal
}): Promise<GitLabCiJobLogResult> {
  let jobs: GitLabPipelineJob[]
  try {
    jobs = await input.client.getPipelineJobs(input.projectId, input.pipelineId, { signal: input.signal })
  } catch (error) {
    return emptyJobLogResult(`ci_jobs_unavailable:${errorName(error)}`)
  }
  const rawJob = jobs.find((candidate) => String(candidate.id) === String(input.jobId))
  if (!rawJob) return emptyJobLogResult('ci_job_not_in_head_pipeline')
  const job = projectCiJob(rawJob)

  const maxBytes = Math.min(MAX_GITLAB_CI_JOB_LOG_BYTES, Math.max(0, Math.floor(input.maxBytes)))
  try {
    const rawTrace = await input.client.getJobTrace(input.projectId, rawJob.id, maxBytes + 1, { signal: input.signal })
    const sanitized = sanitizeGitLabCiTrace(rawTrace)
    const trace = truncateUtf8(sanitized, maxBytes)
    return {
      job,
      trace,
      bytes: byteLength(trace),
      truncated: byteLength(rawTrace) > maxBytes || byteLength(sanitized) > maxBytes,
      diagnostics: [],
    }
  } catch (error) {
    return {
      ...emptyJobLogResult(`ci_job_log_unavailable:${job.id}:${errorName(error)}`),
      job,
    }
  }
}

export function sanitizeGitLabCiTrace(trace: string) {
  return trace
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi, '[REDACTED_KEY_BLOCK]')
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\r\n]+/gi, '$1***')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1***:***@')
    .replace(
      /(^|[\t ;])([A-Z0-9_.-]*(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|db[_-]?url|redis[_-]?url)[A-Z0-9_.-]*)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gim,
      (_match, prefix: string, key: string, separator: string) => `${prefix}${key}${separator.includes(':') ? ':' : '='}***`,
    )
    .replace(/\b(?:glpat-[A-Za-z0-9._-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, '***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '***')
}

function boundCiList(
  pipeline: GitLabCiPipeline,
  jobs: GitLabCiJob[],
  diagnostics: string[],
): GitLabCiListResult {
  const totalJobs = jobs.length
  const selected: GitLabCiJob[] = []
  for (const job of jobs.slice(0, MAX_GITLAB_CI_JOBS)) {
    const candidate = listResult(pipeline, [...selected, job], diagnostics, totalJobs, true)
    if (byteLength(JSON.stringify(candidate)) > MAX_GITLAB_CI_LIST_BYTES) break
    selected.push(job)
  }
  const truncated = selected.length < totalJobs
  return listResult(pipeline, selected, diagnostics, totalJobs, truncated)
}

function listResult(
  pipeline: GitLabCiPipeline,
  jobs: GitLabCiJob[],
  diagnostics: string[],
  totalJobs: number,
  truncated: boolean,
): GitLabCiListResult {
  return {
    pipeline,
    jobs,
    diagnostics: truncated ? uniqueStrings([...diagnostics, 'ci_jobs_truncated']) : diagnostics,
    truncated,
    totalJobs,
    returnedJobs: jobs.length,
  }
}

function emptyListResult(diagnostic: string): GitLabCiListResult {
  return {
    jobs: [],
    diagnostics: [diagnostic],
    truncated: false,
    totalJobs: 0,
    returnedJobs: 0,
  }
}

function projectCiPipeline(pipeline: GitLabPipelineSummary): GitLabCiPipeline {
  return compactObject({
    id: pipeline.id,
    iid: pipeline.iid,
    projectId: pipeline.project_id,
    status: pipeline.status,
    source: pipeline.source,
    sha: pipeline.sha,
    ref: pipeline.ref,
    webUrl: pipeline.web_url,
    createdAt: pipeline.created_at,
    updatedAt: pipeline.updated_at,
  }) as GitLabCiPipeline
}

function projectCiJob(job: GitLabPipelineJob): GitLabCiJob {
  return compactObject({
    id: job.id,
    name: boundedString(job.name, 512),
    stage: boundedString(job.stage, 512),
    status: boundedString(job.status, 512),
    allowFailure: job.allow_failure,
    webUrl: boundedString(job.web_url, 4_096),
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    duration: job.duration,
  }) as GitLabCiJob
}

function emptyJobLogResult(diagnostic: string): GitLabCiJobLogResult {
  return { trace: undefined, bytes: 0, truncated: false, diagnostics: [diagnostic] }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return ''
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value
  const codePoints = Array.from(value)
  while (codePoints.length > 0 && encoder.encode(codePoints.join('')).length > maxBytes) codePoints.pop()
  return codePoints.join('')
}

function boundedString(value: string | undefined, maxLength: number) {
  return value?.slice(0, maxLength)
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)]
}
