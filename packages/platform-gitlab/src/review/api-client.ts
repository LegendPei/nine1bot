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

  async createNote(input: GitLabCreateNoteInput): Promise<unknown> {
    return await this.request(`/api/v4/projects/${encodeURIComponent(String(input.projectId))}/${input.resource}/${encodeURIComponent(String(input.resourceId))}/notes`, {
      method: 'POST',
      body: new URLSearchParams({ body: input.body }),
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
      throw new Error(`GitLab API request failed: ${response.status} ${response.statusText}`)
    }
    return await response.json() as T
  }
}
