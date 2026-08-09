import type { GitLabRawChangesResponse } from './types'

const GITLAB_PAGE_SIZE = 100
const MAX_PAGINATED_PAGES = 5
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_CI_TEXT_LENGTH = 512
const MAX_CI_URL_LENGTH = 4_096

export type GitLabRequestOptions = {
  signal?: AbortSignal
}

export type GitLabApiRedirectErrorCode =
  | 'gitlab_redirect_invalid'
  | 'gitlab_redirect_cross_authority'
  | 'gitlab_redirect_limit_exceeded'

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
  iid?: number
  project_id?: number
  sha?: string
  status?: string
  source?: string
  ref?: string
  web_url?: string
  created_at?: string
  updated_at?: string
}

export type GitLabPipelineJob = {
  id: number
  name?: string
  stage?: string
  status?: string
  allow_failure?: boolean
  web_url?: string
  started_at?: string | null
  finished_at?: string | null
  duration?: number | null
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

export class GitLabApiRedirectError extends Error {
  constructor(readonly code: GitLabApiRedirectErrorCode) {
    super(code)
    this.name = 'GitLabApiRedirectError'
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

  async getMergeRequestPipelines(
    projectId: string | number,
    mrIid: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabPipelineSummary[]> {
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/pipelines`,
      options,
    )
    return values.flatMap((value) => {
      const projected = projectPipelineSummary(value)
      return projected ? [projected] : []
    })
  }

  async getPipelineJobs(
    projectId: string | number,
    pipelineId: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabPipelineJob[]> {
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/pipelines/${encodeURIComponent(String(pipelineId))}/jobs`,
      options,
    )
    return values.flatMap((value) => {
      const projected = projectPipelineJob(value)
      return projected ? [projected] : []
    })
  }

  async getJobTrace(
    projectId: string | number,
    jobId: string | number,
    maxBytes?: number,
    options: GitLabRequestOptions = {},
  ): Promise<string> {
    return await this.requestText(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/jobs/${encodeURIComponent(String(jobId))}/trace`,
      { signal: options.signal },
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
    return (await this.requestPage<T>(path, init)).data
  }

  private async requestPaginated<T>(path: string, options: GitLabRequestOptions = {}): Promise<T[]> {
    const values: T[] = []
    const visitedPages = new Set<string>()
    let page = '1'
    for (let index = 0; index < MAX_PAGINATED_PAGES && !visitedPages.has(page); index += 1) {
      visitedPages.add(page)
      const separator = path.includes('?') ? '&' : '?'
      const result = await this.requestPage<T[]>(
        `${path}${separator}per_page=${GITLAB_PAGE_SIZE}&page=${encodeURIComponent(page)}`,
        { signal: options.signal },
      )
      if (!Array.isArray(result.data)) throw new Error('GitLab API paginated response must be an array')
      values.push(...result.data)
      const nextPage = result.nextPage
      if (!nextPage || !/^\d+$/.test(nextPage)) break
      page = nextPage
    }
    return values
  }

  private async requestPage<T>(path: string, init: RequestInit = {}): Promise<{ data: T; nextPage?: string }> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      const body = await readBoundedText(response, this.maxJsonResponseBytes)
      if (body.truncated) throw new Error(`GitLab API response exceeded ${this.maxJsonResponseBytes} bytes`)
      const text = body.text
      const data = text.trim() ? JSON.parse(text) as T : undefined as T
      const nextPage = response.headers.get('x-next-page')?.trim() || undefined
      return { data, nextPage }
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
        const response = await this.fetchWithSafeRedirects(`${this.baseUrl}${path}`, init, controller.signal)
        return await consume(response)
      })()
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    }
  }

  private async fetchWithSafeRedirects(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const initialUrl = parseHttpUrl(url)
    if (!initialUrl) throw new GitLabApiRedirectError('gitlab_redirect_invalid')
    const authority = initialUrl.host.toLowerCase()
    let currentUrl = initialUrl
    let currentInit = init
    let redirects = 0

    while (true) {
      const headers = new Headers(currentInit.headers)
      headers.set('PRIVATE-TOKEN', this.token)
      const response = await this.fetchImpl(currentUrl, {
        ...currentInit,
        redirect: 'manual',
        signal,
        headers,
      })
      if (!REDIRECT_STATUSES.has(response.status)) return response

      if (redirects >= MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined)
        throw new GitLabApiRedirectError('gitlab_redirect_limit_exceeded')
      }
      const location = response.headers.get('location')
      const target = location ? parseHttpUrl(location, currentUrl) : undefined
      if (!target || (currentUrl.protocol === 'https:' && target.protocol !== 'https:')) {
        await response.body?.cancel().catch(() => undefined)
        throw new GitLabApiRedirectError('gitlab_redirect_invalid')
      }
      if (target.host.toLowerCase() !== authority) {
        await response.body?.cancel().catch(() => undefined)
        throw new GitLabApiRedirectError('gitlab_redirect_cross_authority')
      }

      await response.body?.cancel().catch(() => undefined)
      redirects += 1
      currentInit = redirectedRequestInit(currentInit, response.status)
      currentUrl = target
    }
  }
}

function parseHttpUrl(input: string, base?: URL) {
  try {
    const url = new URL(input, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function projectPipelineSummary(input: unknown): GitLabPipelineSummary | undefined {
  const record = objectRecord(input)
  const id = finiteNumber(record?.id)
  if (id === undefined) return undefined
  return compactObject({
    id,
    iid: finiteNumber(record?.iid),
    project_id: finiteNumber(record?.project_id),
    sha: boundedString(record?.sha, MAX_CI_TEXT_LENGTH),
    status: boundedString(record?.status, MAX_CI_TEXT_LENGTH),
    source: boundedString(record?.source, MAX_CI_TEXT_LENGTH),
    ref: boundedString(record?.ref, MAX_CI_TEXT_LENGTH),
    web_url: boundedString(record?.web_url, MAX_CI_URL_LENGTH),
    created_at: boundedString(record?.created_at, MAX_CI_TEXT_LENGTH),
    updated_at: boundedString(record?.updated_at, MAX_CI_TEXT_LENGTH),
  }) as GitLabPipelineSummary
}

function projectPipelineJob(input: unknown): GitLabPipelineJob | undefined {
  const record = objectRecord(input)
  const id = finiteNumber(record?.id)
  if (id === undefined) return undefined
  return compactObject({
    id,
    name: boundedString(record?.name, MAX_CI_TEXT_LENGTH),
    stage: boundedString(record?.stage, MAX_CI_TEXT_LENGTH),
    status: boundedString(record?.status, MAX_CI_TEXT_LENGTH),
    allow_failure: typeof record?.allow_failure === 'boolean' ? record.allow_failure : undefined,
    web_url: boundedString(record?.web_url, MAX_CI_URL_LENGTH),
    started_at: nullableBoundedString(record?.started_at, MAX_CI_TEXT_LENGTH),
    finished_at: nullableBoundedString(record?.finished_at, MAX_CI_TEXT_LENGTH),
    duration: nullableFiniteNumber(record?.duration),
  }) as GitLabPipelineJob
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function finiteNumber(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function nullableFiniteNumber(input: unknown) {
  return input === null ? null : finiteNumber(input)
}

function boundedString(input: unknown, maxLength: number) {
  return typeof input === 'string' ? input.slice(0, maxLength) : undefined
}

function nullableBoundedString(input: unknown, maxLength: number) {
  return input === null ? null : boundedString(input, maxLength)
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase()
  if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) return init
  const headers = new Headers(init.headers)
  headers.delete('content-length')
  headers.delete('content-type')
  return {
    ...init,
    method: 'GET',
    body: undefined,
    headers,
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
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      const remaining = maxBytes - used
      if (remaining <= 0) {
        truncated = true
        break
      }
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
