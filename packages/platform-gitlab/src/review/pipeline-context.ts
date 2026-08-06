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
    const failing = isUnhealthy(pipeline.status) ? await failedJobs(input, pipeline.id) : []
    return {
      pipeline,
      diagnostics: [],
      contextBlock: block(pipeline, failing),
    }
  } catch (error) {
    return { diagnostics: [`pipeline_context_unavailable:${error instanceof Error ? error.name : 'unknown'}`] }
  }
}

async function failedJobs(input: Parameters<typeof loadGitLabPipelineContext>[0], pipelineId: number) {
  const jobs = await input.client.getPipelineJobs(input.projectId, pipelineId)
  const selected = jobs.filter((job) => isUnhealthy(job.status)).slice(0, input.options.maxFailedJobs)
  return await Promise.all(selected.map(async (job) => ({
    ...job,
    trace: input.options.includeFailedJobLogs ? safeTrace(await input.client.getJobTrace(input.projectId, job.id), input.options.maxJobLogBytes) : undefined,
  })))
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
  const sanitized = trace.replace(/(?:token|password|secret|api[_-]?key)\s*[:=]\s*[^\s]+/gi, (match) =>
    match.replace(/[:=].*/, '=***'),
  )
  return sanitized.length > maxBytes ? `${sanitized.slice(0, maxBytes)}\n[trace truncated]` : sanitized
}
