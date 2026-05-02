import type { GitLabRawChangesResponse } from './types'

export type GitLabApiClientOptions = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
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

export class GitLabApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly responseBody?: string,
  ) {
    super(`GitLab API request failed: ${status} ${statusText}`)
    this.name = 'GitLabApiError'
  }
}

export class GitLabApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(options: GitLabApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
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
    if (input.position) body.set('position', JSON.stringify(input.position))
    return await this.request(`/api/v4/projects/${encodeURIComponent(String(input.projectId))}/${input.resource}/${encodeURIComponent(String(input.resourceId))}/discussions`, {
      method: 'POST',
      body,
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'PRIVATE-TOKEN': this.token,
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      throw new GitLabApiError(response.status, response.statusText, await response.text().catch(() => undefined))
    }
    return await response.json() as T
  }
}
