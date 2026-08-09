import type { GitLabApiClient, GitLabPipelineJob, GitLabPipelineSummary } from './api-client'

export type GitLabCiListResult = {
  pipeline?: GitLabPipelineSummary
  jobs: GitLabPipelineJob[]
  diagnostics: string[]
}

export type GitLabCiJobLogResult = {
  job?: GitLabPipelineJob
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
}): Promise<GitLabCiListResult> {
  let pipelines: GitLabPipelineSummary[]
  try {
    pipelines = await input.client.getMergeRequestPipelines(input.projectId, input.mrIid)
  } catch (error) {
    return { jobs: [], diagnostics: [`ci_pipeline_unavailable:${errorName(error)}`] }
  }
  const pipeline = pipelines.find((candidate) => candidate.sha === input.headSha)
  if (!pipeline) return { jobs: [], diagnostics: ['ci_pipeline_not_found_for_head_sha'] }
  try {
    const jobs = await input.client.getPipelineJobs(input.projectId, pipeline.id)
    return { pipeline, jobs, diagnostics: [] }
  } catch (error) {
    return { pipeline, jobs: [], diagnostics: [`ci_jobs_unavailable:${errorName(error)}`] }
  }
}

export async function readGitLabCiJobLog(input: {
  client: Pick<GitLabApiClient, 'getPipelineJobs' | 'getJobTrace'>
  projectId: string | number
  pipelineId: string | number
  jobId: string | number
  maxBytes: number
}): Promise<GitLabCiJobLogResult> {
  let jobs: GitLabPipelineJob[]
  try {
    jobs = await input.client.getPipelineJobs(input.projectId, input.pipelineId)
  } catch (error) {
    return emptyJobLogResult(`ci_jobs_unavailable:${errorName(error)}`)
  }
  const job = jobs.find((candidate) => String(candidate.id) === String(input.jobId))
  if (!job) return emptyJobLogResult('ci_job_not_in_head_pipeline')

  const maxBytes = Math.max(0, Math.floor(input.maxBytes))
  try {
    const rawTrace = await input.client.getJobTrace(input.projectId, job.id, maxBytes + 1)
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
    .replace(/authorization\s*:\s*bearer\s+[^\s]+/gi, 'Authorization: Bearer ***')
    .replace(/(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, (match) =>
      match.replace(/[:=].*/, '=***'),
    )
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
