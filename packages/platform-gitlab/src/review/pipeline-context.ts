import type { GitLabApiClient, GitLabPipelineJob, GitLabPipelineSummary } from './api-client'

export type GitLabPipelineContext = {
  pipeline?: GitLabPipelineSummary
  diagnostics: string[]
  contextBlock?: {
    id: string
    layer: 'platform'
    source: string
    enabled: boolean
    priority: number
    lifecycle: 'turn'
    visibility: 'system-required'
    content: string
  }
}

export async function loadGitLabPipelineContext(input: {
  client: Pick<GitLabApiClient, 'getMergeRequestPipelines' | 'getPipelineJobs' | 'getJobTrace'>
  projectId: string | number
  mrIid: string | number
  headSha: string
  options: { enabled: boolean; includeFailedJobLogs: boolean; maxFailedJobs: number; maxJobLogBytes: number }
}): Promise<GitLabPipelineContext> {
  if (!input.options.enabled) return { diagnostics: ['pipeline_context_disabled'] }
  try {
    const pipelines = await input.client.getMergeRequestPipelines(input.projectId, input.mrIid)
    const pipeline = pipelines.find((candidate) => candidate.sha === input.headSha)
    if (!pipeline) return { diagnostics: ['pipeline_not_found_for_head_sha'] }
    let failing: Awaited<ReturnType<typeof failedJobs>> = { jobs: [], diagnostics: [] }
    if (isUnhealthy(pipeline.status)) {
      try {
        failing = await failedJobs(input, pipeline.id)
      } catch (error) {
        failing.diagnostics.push(`pipeline_jobs_unavailable:${errorName(error)}`)
      }
    }
    return {
      pipeline,
      diagnostics: failing.diagnostics,
      contextBlock: block(pipeline, failing.jobs),
    }
  } catch (error) {
    return { diagnostics: [`pipeline_context_unavailable:${error instanceof Error ? error.name : 'unknown'}`] }
  }
}

async function failedJobs(input: Parameters<typeof loadGitLabPipelineContext>[0], pipelineId: number) {
  const jobs = await input.client.getPipelineJobs(input.projectId, pipelineId)
  const selected = jobs.filter((job) => isUnhealthy(job.status)).slice(0, input.options.maxFailedJobs)
  const results = await Promise.all(selected.map(async (job) => {
    if (!input.options.includeFailedJobLogs) return { job }
    try {
      const trace = await input.client.getJobTrace(input.projectId, job.id, input.options.maxJobLogBytes)
      return { job: { ...job, trace: safeTrace(trace, input.options.maxJobLogBytes) } }
    } catch (error) {
      return { job, diagnostic: `job_trace_unavailable:${job.id}:${errorName(error)}` }
    }
  }))
  return {
    jobs: results.map((result) => result.job),
    diagnostics: results.flatMap((result) => result.diagnostic ? [result.diagnostic] : []),
  }
}

function block(pipeline: GitLabPipelineSummary, jobs: Array<GitLabPipelineJob & { trace?: string }>) {
  return {
    id: 'gitlab-review-pipeline', layer: 'platform' as const, source: 'platform.gitlab.review.pipeline', enabled: true,
    priority: 89, lifecycle: 'turn' as const, visibility: 'system-required' as const,
    content: [
      'GitLab CI/CD evidence', `Pipeline ID: ${pipeline.id}`, `Pipeline status: ${pipeline.status ?? 'unknown'}`,
      pipeline.web_url ? `Pipeline URL: ${pipeline.web_url}` : undefined,
      ...jobs.flatMap((job) => [`- ${job.name ?? job.id} (${job.stage ?? 'unknown'}): ${job.status ?? 'unknown'}`, job.failure_reason ? `  Failure reason: ${job.failure_reason}` : undefined, job.trace ? `  Trace:\n${job.trace}` : undefined]),
    ].filter(Boolean).join('\n'),
  }
}

function isUnhealthy(status: string | undefined) {
  return status === 'failed' || status === 'canceled' || status === 'manual'
}

function safeTrace(trace: string, maxBytes: number) {
  const sanitized = trace
    .replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/authorization\s*:\s*bearer\s+[^\s]+/gi, 'Authorization: Bearer ***')
    .replace(/(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, (match) =>
      match.replace(/[:=].*/, '=***'),
    )
  return truncateUtf8(sanitized, maxBytes)
}

function truncateUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value
  const codePoints = Array.from(value)
  while (codePoints.length > 0 && encoder.encode(codePoints.join('')).length > maxBytes) codePoints.pop()
  return codePoints.join('')
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : 'unknown'
}
