import { normalizeGitLabAuthority } from './host'

export type GitLabReviewSettings = {
  enabled: boolean
  baseUrl?: string
  botMention: string
  allowedHosts: string[]
  allowedProjectIds: Array<string | number>
  scopeMode: GitLabReviewScopeMode
  includedProjects: GitLabProjectRef[]
  excludedProjects: GitLabProjectRef[]
  projects: GitLabReviewProjectProfile[]
  hookGroups: GitLabGroupRef[]
  webhookSecretRef?: GitLabReviewSecretRef
  tokenSecretRef?: GitLabReviewSecretRef
  manualMentionTrigger: boolean
  webhookAutoReview: boolean
  inlineComments: boolean
  dryRun: boolean
  maxDiffBytes: number
  maxFiles: number
  executionMode: 'dry-run' | 'runtime'
  modelProviderId?: string
  modelId?: string
  configurationErrors: string[]
}

export type GitLabReviewScopeMode = 'all-received' | 'selected-only'

export type GitLabProjectRef = {
  id: string | number
  pathWithNamespace?: string
  webUrl?: string
}

export type GitLabReviewProjectProfile = {
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

export type GitLabReviewProjectSnapshot = GitLabReviewProjectProfile & {
  source: 'configured' | 'unconfigured'
  matchedAt: number
}

export type GitLabGroupRef = {
  id: string | number
  fullPath?: string
  webUrl?: string
}

export type GitLabReviewSecretRef = string | {
  provider: 'nine1bot-local' | 'env' | 'external'
  key: string
}

export const defaultGitLabWebhookSecretRef: GitLabReviewSecretRef = {
  provider: 'nine1bot-local',
  key: 'platform:gitlab:default:review.webhookSecretRef',
}

export const defaultGitLabReviewSettings: GitLabReviewSettings = {
  enabled: false,
  baseUrl: undefined,
  botMention: '@Nine1bot',
  allowedHosts: [],
  allowedProjectIds: [],
  scopeMode: 'all-received',
  includedProjects: [],
  excludedProjects: [],
  projects: [],
  hookGroups: [],
  webhookSecretRef: defaultGitLabWebhookSecretRef,
  manualMentionTrigger: true,
  webhookAutoReview: false,
  inlineComments: true,
  dryRun: true,
  maxDiffBytes: 240_000,
  maxFiles: 80,
  executionMode: 'dry-run',
  modelProviderId: undefined,
  modelId: undefined,
  configurationErrors: [],
}

export function normalizeGitLabReviewSettings(input: unknown): GitLabReviewSettings {
  const record = isRecord(input) ? input : {}
  const allowedHosts = allowedHostList(setting(record, 'allowedHosts'))
  const projects = projectProfileList(setting(record, 'review.projects', 'projects'))
  const legacyAllowedProjectIds = idList(setting(record, 'review.allowedProjectIds', 'allowedProjectIds'))
  const explicitScopeMode = scopeModeValue(setting(record, 'review.scopeMode', 'scopeMode'))
  const includedProjects = projectRefList(setting(record, 'review.includedProjects', 'includedProjects'))
  const scopeMode = explicitScopeMode ?? (legacyAllowedProjectIds.length > 0 && includedProjects.length === 0 ? 'selected-only' : defaultGitLabReviewSettings.scopeMode)
  return {
    ...defaultGitLabReviewSettings,
    enabled: booleanValue(setting(record, 'review.enabled', 'enabled'), defaultGitLabReviewSettings.enabled),
    baseUrl: optionalString(setting(record, 'review.baseUrl', 'baseUrl')),
    botMention: stringValue(setting(record, 'review.botMention', 'botMention'), defaultGitLabReviewSettings.botMention),
    allowedHosts: allowedHosts.hosts,
    allowedProjectIds: legacyAllowedProjectIds,
    scopeMode,
    includedProjects: includedProjects.length > 0 ? includedProjects : legacyAllowedProjectIds.map((id) => ({ id })),
    excludedProjects: projectRefList(setting(record, 'review.excludedProjects', 'excludedProjects')),
    projects,
    hookGroups: groupRefList(setting(record, 'review.hookGroups', 'hookGroups')),
    webhookSecretRef: optionalSecretRef(setting(record, 'review.webhookSecretRef', 'webhookSecretRef')) ?? defaultGitLabReviewSettings.webhookSecretRef,
    tokenSecretRef: optionalSecretRef(setting(record, 'review.tokenSecretRef', 'tokenSecretRef')),
    manualMentionTrigger: booleanValue(setting(record, 'review.manualMentionTrigger', 'manualMentionTrigger'), defaultGitLabReviewSettings.manualMentionTrigger),
    webhookAutoReview: booleanValue(setting(record, 'review.webhookAutoReview', 'webhookAutoReview'), defaultGitLabReviewSettings.webhookAutoReview),
    inlineComments: booleanValue(setting(record, 'review.inlineComments', 'inlineComments'), defaultGitLabReviewSettings.inlineComments),
    dryRun: booleanValue(setting(record, 'review.dryRun', 'dryRun'), defaultGitLabReviewSettings.dryRun),
    maxDiffBytes: positiveNumber(setting(record, 'review.maxDiffBytes', 'maxDiffBytes'), defaultGitLabReviewSettings.maxDiffBytes),
    maxFiles: positiveNumber(setting(record, 'review.maxFiles', 'maxFiles'), defaultGitLabReviewSettings.maxFiles),
    executionMode: setting(record, 'review.executionMode', 'executionMode') === 'runtime' ? 'runtime' : 'dry-run',
    modelProviderId: optionalString(setting(record, 'review.modelProviderId', 'modelProviderId')),
    modelId: optionalString(setting(record, 'review.modelId', 'modelId')),
    configurationErrors: [
      ...(allowedHosts.valid ? [] : ['allowed_hosts_invalid']),
      ...projectProfileConfigurationErrors(projects),
    ],
  }
}

export function isGitLabReviewProjectInScope(
  settings: GitLabReviewSettings,
  project: { id: string | number; pathWithNamespace?: string },
) {
  if (projectRefMatches(settings.excludedProjects, project)) return false
  if (settings.scopeMode === 'selected-only') {
    return projectRefMatches(settings.includedProjects, project)
  }
  return true
}

export function gitLabReviewProjectIdsForHookSync(settings: GitLabReviewSettings): Array<string | number> {
  const candidates = settings.scopeMode === 'selected-only'
    ? settings.includedProjects
    : settings.includedProjects.length > 0
      ? settings.includedProjects
      : settings.allowedProjectIds.map((id) => ({ id }))
  return uniqueIds(candidates.map((project) => project.id))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function projectRefMatches(projects: GitLabProjectRef[], project: { id: string | number; pathWithNamespace?: string }) {
  return projects.some((candidate) => {
    if (String(candidate.id) === String(project.id)) return true
    return Boolean(candidate.pathWithNamespace && project.pathWithNamespace && candidate.pathWithNamespace === project.pathWithNamespace)
  })
}

function uniqueIds(ids: Array<string | number>) {
  const seen = new Set<string>()
  const output: Array<string | number> = []
  for (const id of ids) {
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    output.push(id)
  }
  return output
}

function booleanValue(input: unknown, fallback: boolean) {
  return typeof input === 'boolean' ? input : fallback
}

function stringValue(input: unknown, fallback: string) {
  return typeof input === 'string' && input.trim() ? input.trim() : fallback
}

function optionalString(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function optionalSecretRef(input: unknown): GitLabReviewSecretRef | undefined {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (!isRecord(input)) return undefined
  if (
    (input.provider === 'nine1bot-local' || input.provider === 'env' || input.provider === 'external') &&
    typeof input.key === 'string'
  ) {
    return {
      provider: input.provider,
      key: input.key,
    }
  }
  return undefined
}

function stringList(input: unknown) {
  return Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}

function allowedHostList(input: unknown) {
  if (input === undefined) return { hosts: [] as string[], valid: true }
  if (!Array.isArray(input)) return { hosts: [] as string[], valid: false }
  const hosts: string[] = []
  let valid = true
  for (const item of input) {
    if (typeof item !== 'string' || !item.trim()) {
      valid = false
      continue
    }
    const normalized = normalizeGitLabAuthority(item)
    if (!normalized) {
      valid = false
      continue
    }
    if (!hosts.includes(normalized)) hosts.push(normalized)
  }
  return { hosts, valid }
}

function idList(input: unknown) {
  return Array.isArray(input)
    ? input.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    : []
}

function scopeModeValue(input: unknown): GitLabReviewScopeMode | undefined {
  return input === 'selected-only' || input === 'all-received' ? input : undefined
}

function projectRefList(input: unknown): GitLabProjectRef[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return { id: item }
      if (!isRecord(item)) return undefined
      const id = item.id
      if (typeof id !== 'string' && typeof id !== 'number') return undefined
      return {
        id,
        pathWithNamespace: optionalString(item.pathWithNamespace) ?? optionalString(item.path_with_namespace),
        webUrl: optionalString(item.webUrl) ?? optionalString(item.web_url),
      }
    })
    .filter((item): item is GitLabProjectRef => Boolean(item))
}

function projectProfileList(input: unknown): GitLabReviewProjectProfile[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    if (!isRecord(item)) return []
    const id = optionalString(item.id)
    const projectId = item.projectId ?? item.project_id
    if (!id || (typeof projectId !== 'string' && typeof projectId !== 'number')) return []
    return [{
      id,
      host: normalizeGitLabAuthority(optionalString(item.host)),
      projectId,
      nine1botProjectID: optionalString(item.nine1botProjectID) ?? optionalString(item.nine1bot_project_id) ?? '',
      pathWithNamespace: optionalString(item.pathWithNamespace) ?? optionalString(item.path_with_namespace),
      displayName: optionalString(item.displayName) ?? optionalString(item.display_name),
      enabled: booleanValue(item.enabled, true),
      reviewContextMarkdown: optionalString(item.reviewContextMarkdown) ?? optionalString(item.review_context_markdown) ??
        optionalString(item.contextMarkdown) ?? optionalString(item.context_markdown),
      reviewFocus: stringList(item.reviewFocus ?? item.review_focus),
      includePathPrefixes: stringList(item.includePathPrefixes ?? item.include_path_prefixes),
      excludePathPatterns: stringList(item.excludePathPatterns ?? item.exclude_path_patterns),
      maxContextBytes: optionalPositiveNumber(item.maxContextBytes ?? item.max_context_bytes),
      maxFiles: optionalPositiveNumber(item.maxFiles ?? item.max_files),
      ci: {
        maxJobLogs: positiveNumber(
          recordValue(item.ci)?.maxJobLogs
            ?? recordValue(item.ci)?.max_job_logs
            ?? recordValue(item.ci)?.maxFailedJobs
            ?? recordValue(item.ci)?.max_failed_jobs,
          3,
        ),
        maxJobLogBytes: positiveNumber(recordValue(item.ci)?.maxJobLogBytes ?? recordValue(item.ci)?.max_job_log_bytes, 8_000),
      },
    }]
  })
}

function projectProfileConfigurationErrors(projects: GitLabReviewProjectProfile[]) {
  const errors: string[] = []
  const ids = new Set<string>()
  const identities = new Set<string>()
  for (const project of projects) {
    if (ids.has(project.id)) errors.push(`project_profile_id_duplicate:${project.id}`)
    ids.add(project.id)
    if (!project.host) {
      errors.push(`project_profile_host_invalid:${project.id}`)
    } else {
      const identity = `${project.host}:${String(project.projectId)}`
      if (identities.has(identity)) errors.push(`project_profile_identity_duplicate:${identity}`)
      identities.add(identity)
    }
    if (!project.nine1botProjectID) errors.push(`project_binding_missing:${project.id}`)
  }
  return errors
}

function groupRefList(input: unknown): GitLabGroupRef[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return { id: item }
      if (!isRecord(item)) return undefined
      const id = item.id
      if (typeof id !== 'string' && typeof id !== 'number') return undefined
      return {
        id,
        fullPath: optionalString(item.fullPath) ?? optionalString(item.full_path),
        webUrl: optionalString(item.webUrl) ?? optionalString(item.web_url),
      }
    })
    .filter((item): item is GitLabGroupRef => Boolean(item))
}

function positiveNumber(input: unknown, fallback: number) {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : fallback
}

function optionalPositiveNumber(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : undefined
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

function setting(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
  }
  return undefined
}
