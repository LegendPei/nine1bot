import type { GitLabRawChangesResponse } from './types'

export type GitLabApiClientOptions = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  requestTimeoutMs?: number
  maxJsonResponseBytes?: number
  maxErrorResponseBytes?: number
}

export type GitLabCreateNoteInput = {
  projectId: string | number
  resource: 'merge_requests' | 'repository/commits'
  resourceId: string | number
  body: string
}

export type GitLabCreateDiscussionInput = GitLabCreateNoteInput & {
  position?: Record<string, unknown>
}

export type GitLabTokenSelf = {
  id?: number
  name?: string
  user_id?: number
  scopes?: string[]
  active?: boolean
  revoked?: boolean
  expires_at?: string | null
}

export type GitLabProjectHook = {
  id: number
  url: string
  project_id?: number
  push_events?: boolean
  merge_requests_events?: boolean
  note_events?: boolean
  enable_ssl_verification?: boolean
}

export type GitLabPipelineSummary = {
  id: number
  sha?: string
  status?: string
  ref?: string
  web_url?: string
}

export type GitLabPipelineJob = {
  id: number
  name?: string
  stage?: string
  status?: string
  failure_reason?: string | null
  web_url?: string
}

export type GitLabProjectSummary = {
  id: number
  path_with_namespace?: string
  web_url?: string
  name?: string
  namespace?: {
    full_path?: string
  }
}

export type GitLabGroupSummary = {
  id: number
  full_path?: string
  web_url?: string
  name?: string
  path?: string
}

export type GitLabProjectHookInput = {
  projectId: string | number
  url: string
  hookId?: string | number
  noteEvents?: boolean
  mergeRequestEvents?: boolean
  pushEvents?: boolean
  enableSslVerification?: boolean
}

export type GitLabGroupHookInput = {
  groupId: string | number
  url: string
  hookId?: string | number
  noteEvents?: boolean
  mergeRequestEvents?: boolean
  pushEvents?: boolean
  enableSslVerification?: boolean
}

export type GitLabHookTestTrigger = 'push_events' | 'merge_requests_events' | 'note_events'

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly responseBody?: string,
  ) {
    super(responseBody ? `GitLab API request failed: ${status} ${statusText}: ${responseBody}` : `GitLab API request failed: ${status} ${statusText}`)
    this.name = 'GitLabApiError'
  }
}

export class GitLabApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly maxJsonResponseBytes: number
  private readonly maxErrorResponseBytes: number

  constructor(options: GitLabApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? 16_000_000
    this.maxErrorResponseBytes = options.maxErrorResponseBytes ?? 16_000
  }

  async getMergeRequestChanges(projectId: string | number, mrIid: string | number): Promise<GitLabRawChangesResponse> {
    return await this.request<GitLabRawChangesResponse>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/changes`,
    )
  }

  async getCommitDiff(projectId: string | number, commitSha: string | number): Promise<GitLabRawChangesResponse> {
    const changes = await this.request<GitLabRawChangesResponse['changes']>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/commits/${encodeURIComponent(String(commitSha))}/diff`,
    )
    return { changes: changes ?? [] }
  }

  async getMergeRequestPipelines(projectId: string | number, mrIid: string | number): Promise<GitLabPipelineSummary[]> {
    return await this.request<GitLabPipelineSummary[]>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/pipelines`,
    )
  }

  async getPipelineJobs(projectId: string | number, pipelineId: string | number): Promise<GitLabPipelineJob[]> {
    return await this.request<GitLabPipelineJob[]>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/pipelines/${encodeURIComponent(String(pipelineId))}/jobs`,
    )
  }

  async getJobTrace(projectId: string | number, jobId: string | number, maxBytes?: number): Promise<string> {
    return await this.requestText(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/jobs/${encodeURIComponent(String(jobId))}/trace`,
      {},
      maxBytes,
    )
  }

  async getTokenSelf(): Promise<GitLabTokenSelf> {
    return await this.request<GitLabTokenSelf>('/api/v4/personal_access_tokens/self')
  }

  async searchProjects(query: string, limit = 20): Promise<GitLabProjectSummary[]> {
    const params = new URLSearchParams({
      simple: 'true',
      per_page: String(limit),
    })
    if (query.trim()) params.set('search', query.trim())
    return await this.request<GitLabProjectSummary[]>(`/api/v4/projects?${params}`)
  }

  async searchGroups(query: string, limit = 20): Promise<GitLabGroupSummary[]> {
    const params = new URLSearchParams({
      per_page: String(limit),
    })
    if (query.trim()) params.set('search', query.trim())
    return await this.request<GitLabGroupSummary[]>(`/api/v4/groups?${params}`)
  }

  async listProjectHooks(projectId: string | number): Promise<GitLabProjectHook[]> {
    return await this.request<GitLabProjectHook[]>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/hooks`,
    )
  }

  async createProjectHook(input: GitLabProjectHookInput): Promise<GitLabProjectHook> {
    const body = projectHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/hooks`,
      {
        method: 'POST',
        body,
      },
    )
  }

  async updateProjectHook(input: GitLabProjectHookInput & { hookId: string | number }): Promise<GitLabProjectHook> {
    const body = projectHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/hooks/${encodeURIComponent(String(input.hookId))}`,
      {
        method: 'PUT',
        body,
      },
    )
  }

  async testProjectHook(
    projectId: string | number,
    hookId: string | number,
    trigger: GitLabHookTestTrigger,
  ): Promise<unknown> {
    return await this.request<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/hooks/${encodeURIComponent(String(hookId))}/test/${trigger}`,
      {
        method: 'POST',
      },
    )
  }

  async listGroupHooks(groupId: string | number): Promise<GitLabProjectHook[]> {
    return await this.request<GitLabProjectHook[]>(
      `/api/v4/groups/${encodeURIComponent(String(groupId))}/hooks`,
    )
  }

  async createGroupHook(input: GitLabGroupHookInput): Promise<GitLabProjectHook> {
    const body = groupHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/groups/${encodeURIComponent(String(input.groupId))}/hooks`,
      {
        method: 'POST',
        body,
      },
    )
  }

  async updateGroupHook(input: GitLabGroupHookInput & { hookId: string | number }): Promise<GitLabProjectHook> {
    const body = groupHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/groups/${encodeURIComponent(String(input.groupId))}/hooks/${encodeURIComponent(String(input.hookId))}`,
      {
        method: 'PUT',
        body,
      },
    )
  }

  async testGroupHook(
    groupId: string | number,
    hookId: string | number,
    trigger: GitLabHookTestTrigger,
  ): Promise<unknown> {
    return await this.request<unknown>(
      `/api/v4/groups/${encodeURIComponent(String(groupId))}/hooks/${encodeURIComponent(String(hookId))}/test/${trigger}`,
      {
        method: 'POST',
      },
    )
  }

  async createNote(input: GitLabCreateNoteInput): Promise<unknown> {
    const notePath = input.resource === 'repository/commits'
      ? `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/repository/commits/${encodeURIComponent(String(input.resourceId))}/comments`
      : `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${encodeURIComponent(String(input.resourceId))}/notes`
    const body = input.resource === 'repository/commits'
      ? new URLSearchParams({ note: input.body })
      : new URLSearchParams({ body: input.body })
    return await this.request(notePath, {
      method: 'POST',
      body,
    })
  }

  async createDiscussion(input: GitLabCreateDiscussionInput): Promise<unknown> {
    const body = new URLSearchParams({ body: input.body })
    if (input.position) appendNestedFormFields(body, 'position', input.position)
    return await this.request(`/api/v4/projects/${encodeURIComponent(String(input.projectId))}/${input.resource}/${encodeURIComponent(String(input.resourceId))}/discussions`, {
      method: 'POST',
      body,
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      const body = await readBoundedText(response, this.maxJsonResponseBytes)
      if (body.truncated) throw new Error(`GitLab API response exceeded ${this.maxJsonResponseBytes} bytes`)
      const text = body.text
      if (!text.trim()) return undefined as T
      return JSON.parse(text) as T
    })
  }

  private async requestText(path: string, init: RequestInit = {}, maxBytes?: number): Promise<string> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      return (await readBoundedText(response, maxBytes ?? this.maxJsonResponseBytes)).text
    })
  }

  private async withRequest<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) onUpstreamAbort()
    else upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true })
    const timeoutError = new Error(`GitLab API request timed out after ${this.requestTimeoutMs}ms`)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, this.requestTimeoutMs)
    })
    try {
      const operation = (async () => {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            'PRIVATE-TOKEN': this.token,
            ...(init.headers ?? {}),
          },
        })
        return await consume(response)
      })()
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    }
  }
}

async function readBoundedText(response: Response, maxBytes?: number) {
  if (!maxBytes || maxBytes <= 0) {
    await response.body?.cancel().catch(() => undefined)
    return { text: '', truncated: Boolean(response.body) }
  }
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let used = 0
  let completed = false
  let truncated = false
  try {
    while (used < maxBytes) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      const remaining = maxBytes - used
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
      chunks.push(chunk)
      used += chunk.byteLength
      if (value.byteLength > remaining) {
        truncated = true
        break
      }
    }
  } finally {
    if (!completed) {
      truncated = true
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  const bytes = new Uint8Array(used)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: truncateUtf8(new TextDecoder().decode(bytes), maxBytes), truncated }
}

function truncateUtf8(value: string, maxBytes: number) {
  const encoder = new TextEncoder()
  if (encoder.encode(value).length <= maxBytes) return value
  const codePoints = Array.from(value)
  while (codePoints.length > 0 && encoder.encode(codePoints.join('')).length > maxBytes) codePoints.pop()
  return codePoints.join('')
}

function projectHookBody(input: GitLabProjectHookInput) {
  const body = new URLSearchParams({
    url: input.url,
    note_events: String(input.noteEvents ?? true),
    merge_requests_events: String(input.mergeRequestEvents ?? true),
    push_events: String(input.pushEvents ?? false),
    enable_ssl_verification: String(input.enableSslVerification ?? true),
  })
  return body
}

function groupHookBody(input: GitLabGroupHookInput) {
  const body = new URLSearchParams({
    url: input.url,
    note_events: String(input.noteEvents ?? true),
    merge_requests_events: String(input.mergeRequestEvents ?? true),
    push_events: String(input.pushEvents ?? false),
    enable_ssl_verification: String(input.enableSslVerification ?? true),
  })
  return body
}

function appendNestedFormFields(body: URLSearchParams, prefix: string, value: Record<string, unknown>) {
  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue === undefined || nestedValue === null) continue
    body.set(`${prefix}[${key}]`, String(nestedValue))
  }
}
