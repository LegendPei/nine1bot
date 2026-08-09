export type GitLabProjectRef = {
  id: string | number
  pathWithNamespace?: string
  webUrl?: string
}

export type GitLabProjectProfile = {
  id: string
  host?: string
  projectId: string | number
  nine1botProjectID: string
  pathWithNamespace?: string
  displayName?: string
  enabled: boolean
  reviewContextMarkdown?: string
  reviewFocus: string[]
  includePathPrefixes: string[]
  excludePathPatterns: string[]
  maxContextBytes?: number
  maxFiles?: number
  ci: {
    maxJobLogs: number
    maxJobLogBytes: number
  }
}

export function parseGitLabProjectProfiles(input: string | unknown): GitLabProjectProfile[] {
  let parsed: unknown
  try {
    parsed = typeof input === 'string' ? JSON.parse(input || '[]') : input
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const ids = new Set<string>()
  const identities = new Set<string>()
  return parsed.flatMap((item): GitLabProjectProfile[] => {
    if (!isRecord(item)) return []
    const id = optionalGitLabProfileText(item.id)
    const projectId = item.projectId ?? item.project_id
    if (!id || !isProjectId(projectId) || ids.has(id)) return []

    const host = gitLabProjectHost(item.host)
    const identity = gitLabProjectIdentityKey(host, projectId)
    if (identities.has(identity)) return []
    ids.add(id)
    identities.add(identity)

    const ci = isRecord(item.ci) ? item.ci : {}
    return [{
      id,
      host,
      projectId,
      nine1botProjectID: optionalGitLabProfileText(item.nine1botProjectID ?? item.nine1bot_project_id) ?? '',
      pathWithNamespace: optionalGitLabProfileText(item.pathWithNamespace ?? item.path_with_namespace),
      displayName: optionalGitLabProfileText(item.displayName ?? item.display_name),
      enabled: item.enabled !== false,
      reviewContextMarkdown: optionalGitLabProfileText(
        item.reviewContextMarkdown
          ?? item.review_context_markdown
          ?? item.contextMarkdown
          ?? item.context_markdown,
      ),
      reviewFocus: gitLabProfileTextList(item.reviewFocus ?? item.review_focus),
      includePathPrefixes: gitLabProfileTextList(item.includePathPrefixes ?? item.include_path_prefixes),
      excludePathPatterns: gitLabProfileTextList(item.excludePathPatterns ?? item.exclude_path_patterns),
      maxContextBytes: optionalGitLabProfileNumber(item.maxContextBytes ?? item.max_context_bytes),
      maxFiles: optionalGitLabProfileNumber(item.maxFiles ?? item.max_files),
      ci: {
        maxJobLogs: positiveGitLabProfileNumber(
          ci.maxJobLogs ?? ci.max_job_logs ?? ci.maxFailedJobs ?? ci.max_failed_jobs,
          3,
        ),
        maxJobLogBytes: positiveGitLabProfileNumber(ci.maxJobLogBytes ?? ci.max_job_log_bytes, 8_000),
      },
    }]
  })
}

export function serializeGitLabProjectProfiles(profiles: GitLabProjectProfile[]) {
  const canonical = parseGitLabProjectProfiles(profiles).map((profile) => ({
    id: profile.id,
    host: profile.host,
    projectId: profile.projectId,
    nine1botProjectID: profile.nine1botProjectID,
    pathWithNamespace: profile.pathWithNamespace,
    displayName: profile.displayName,
    enabled: profile.enabled,
    reviewContextMarkdown: profile.reviewContextMarkdown,
    reviewFocus: profile.reviewFocus,
    includePathPrefixes: profile.includePathPrefixes,
    excludePathPatterns: profile.excludePathPatterns,
    maxContextBytes: profile.maxContextBytes,
    maxFiles: profile.maxFiles,
    ci: {
      maxJobLogs: profile.ci.maxJobLogs,
      maxJobLogBytes: profile.ci.maxJobLogBytes,
    },
  }))
  return JSON.stringify(canonical, null, 2)
}

export function createGitLabProjectProfile(
  project: GitLabProjectRef,
  configuredBaseUrl?: string,
): GitLabProjectProfile {
  const host = gitLabProjectHost(project.webUrl) ?? gitLabProjectHost(configuredBaseUrl)
  return {
    id: gitLabProjectProfileId(host, project.id),
    host,
    projectId: project.id,
    nine1botProjectID: '',
    pathWithNamespace: project.pathWithNamespace,
    displayName: project.pathWithNamespace,
    enabled: true,
    reviewContextMarkdown: undefined,
    reviewFocus: [],
    includePathPrefixes: [],
    excludePathPatterns: [],
    maxContextBytes: undefined,
    maxFiles: undefined,
    ci: { maxJobLogs: 3, maxJobLogBytes: 8_000 },
  }
}

export function gitLabProjectIdentityKey(host: string | undefined, projectId: string | number) {
  return `${gitLabProjectHost(host) ?? ''}:${String(projectId)}`
}

export function gitLabProjectHost(value?: unknown) {
  const text = optionalGitLabProfileText(value)
  if (!text) return undefined
  try {
    const url = new URL(text.includes('://') ? text : `https://${text}`)
    return url.host.toLowerCase()
  } catch {
    return undefined
  }
}

export function optionalGitLabProfileNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function positiveGitLabProfileNumber(value: unknown, fallback: number) {
  return optionalGitLabProfileNumber(value) ?? fallback
}

function gitLabProjectProfileId(host: string | undefined, projectId: string | number) {
  const authority = (host || 'gitlab').replace(/[^a-z0-9.-]/gi, '-')
  const id = String(projectId).replace(/[^a-z0-9.-]/gi, '-')
  return `project-${authority}-${id}`
}

function optionalGitLabProfileText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function gitLabProfileTextList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

function isProjectId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
