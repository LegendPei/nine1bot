import {
  gitLabProjectHost,
  parseGitLabProjectProfiles,
  type GitLabProjectProfile,
} from './gitlab-project-profiles'

export type GitLabProjectProfileDiagnostic = {
  code: string
  message: string
  index?: number
  profileId?: string
}

export type GitLabProjectProfileDocument = {
  root: unknown
  entries: unknown[]
  editable: Array<{ index: number; profile: GitLabProjectProfile }>
  sourceText?: string
  parseError?: string
}

export type GitLabProjectProfileDocumentSerialization =
  | { ok: true; value: string }
  | { ok: false; diagnostics: GitLabProjectProfileDiagnostic[] }

export function parseGitLabProjectProfileDocument(input: string | unknown): GitLabProjectProfileDocument {
  let root: unknown = input
  const sourceText = typeof input === 'string' ? input : undefined
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input.trim() || '[]')
    } catch (error) {
      return {
        root: input,
        entries: [],
        editable: [],
        sourceText: input,
        parseError: error instanceof Error ? error.message : 'Invalid JSON',
      }
    }
  }

  const entries = Array.isArray(root) ? [...root] : []
  return {
    root,
    entries,
    editable: entries.flatMap((entry, index) => {
      const profile = parseGitLabProjectProfiles([entry])[0]
      return profile ? [{ index, profile }] : []
    }),
    sourceText,
  }
}

export function validateGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
): GitLabProjectProfileDiagnostic[] {
  if (document.parseError) {
    return [{ code: 'json_invalid', message: `JSON 格式错误：${document.parseError}` }]
  }
  if (!Array.isArray(document.root)) {
    return [{ code: 'profiles_not_array', message: '项目审查档案必须是 JSON 数组。' }]
  }

  const diagnostics: GitLabProjectProfileDiagnostic[] = []
  const ids = new Set<string>()
  const identities = new Set<string>()
  for (const [index, entry] of document.entries.entries()) {
    if (!isRecord(entry)) {
      diagnostics.push(diagnostic('profile_invalid', '该条目必须是对象。', index))
      continue
    }

    const id = optionalText(entry.id)
    if (!id) {
      diagnostics.push(diagnostic('profile_id_missing', '缺少有效的档案 ID。', index))
      continue
    }
    const projectId = entry.projectId ?? entry.project_id
    if (!isProjectId(projectId)) {
      diagnostics.push(diagnostic('profile_project_id_missing', '缺少有效的 GitLab 项目 ID。', index, id))
      continue
    }

    const host = gitLabProjectHost(entry.host)
    if (!host) diagnostics.push(diagnostic('profile_host_invalid', 'GitLab host 无效。', index, id))
    const binding = optionalText(entry.nine1botProjectID ?? entry.nine1bot_project_id)
    if (!binding) diagnostics.push(diagnostic('profile_binding_missing', '尚未绑定 Nine1Bot 项目。', index, id))

    if (ids.has(id)) diagnostics.push(diagnostic('profile_id_duplicate', `档案 ID ${id} 重复。`, index, id))
    ids.add(id)
    if (host) {
      const identity = `${host}:${String(projectId)}`
      if (identities.has(identity)) {
        diagnostics.push(diagnostic('profile_identity_duplicate', `GitLab 项目标识 ${identity} 重复。`, index, id))
      }
      identities.add(identity)
    }

    if (entry.ci !== undefined && !isRecord(entry.ci)) {
      diagnostics.push(diagnostic('profile_ci_invalid', 'CI 配置必须是对象。', index, id))
      continue
    }
    const ci = isRecord(entry.ci) ? entry.ci : {}
    const maxJobLogs = ci.maxJobLogs ?? ci.max_job_logs ?? ci.maxFailedJobs ?? ci.max_failed_jobs
    const maxJobLogBytes = ci.maxJobLogBytes ?? ci.max_job_log_bytes
    if (maxJobLogs !== undefined && !isPositiveNumber(maxJobLogs)) {
      diagnostics.push(diagnostic('profile_ci_max_job_logs_invalid', 'CI 日志数量必须是正数。', index, id))
    }
    if (maxJobLogBytes !== undefined && !isPositiveNumber(maxJobLogBytes)) {
      diagnostics.push(diagnostic('profile_ci_max_job_log_bytes_invalid', 'CI 日志字节上限必须是正数。', index, id))
    }
  }
  return diagnostics
}

export function updateGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
  index: number,
  profile: GitLabProjectProfile,
) {
  if (!Array.isArray(document.root) || index < 0 || index >= document.entries.length) return document
  const current = document.editable.find((entry) => entry.index === index)
  if (!current) return document
  const entries = [...document.entries]
  entries[index] = updateRawProfile(entries[index], current.profile, profile)
  return parseGitLabProjectProfileDocument(entries)
}

export function appendGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
  profile: GitLabProjectProfile,
) {
  if (!Array.isArray(document.root)) return document
  return parseGitLabProjectProfileDocument([...document.entries, canonicalProfileEntry({}, profile)])
}

export function removeGitLabProjectProfileDocument(document: GitLabProjectProfileDocument, index: number) {
  if (!Array.isArray(document.root) || index < 0 || index >= document.entries.length) return document
  return parseGitLabProjectProfileDocument(document.entries.filter((_, entryIndex) => entryIndex !== index))
}

export function renderGitLabProjectProfileDocument(document: GitLabProjectProfileDocument) {
  if (document.parseError) return document.sourceText ?? ''
  return JSON.stringify(Array.isArray(document.root) ? document.entries : document.root, null, 2)
}

export function serializeGitLabProjectProfileDocument(
  document: GitLabProjectProfileDocument,
): GitLabProjectProfileDocumentSerialization {
  const diagnostics = validateGitLabProjectProfileDocument(document)
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const profiles = new Map(document.editable.map((entry) => [entry.index, entry.profile]))
  const entries = document.entries.map((entry, index) => canonicalProfileEntry(entry, profiles.get(index)!))
  return { ok: true, value: JSON.stringify(entries, null, 2) }
}

function updateRawProfile(raw: unknown, previous: GitLabProjectProfile, next: GitLabProjectProfile) {
  const output = isRecord(raw) ? { ...raw } : {}
  updateField(output, previous.id, next.id, 'id', [])
  updateField(output, previous.host, next.host, 'host', [])
  updateField(output, previous.projectId, next.projectId, 'projectId', ['project_id'])
  updateField(output, previous.nine1botProjectID, next.nine1botProjectID, 'nine1botProjectID', ['nine1bot_project_id'])
  updateField(output, previous.pathWithNamespace, next.pathWithNamespace, 'pathWithNamespace', ['path_with_namespace'])
  updateField(output, previous.displayName, next.displayName, 'displayName', ['display_name'])
  updateField(output, previous.enabled, next.enabled, 'enabled', [])
  updateField(output, previous.reviewContextMarkdown, next.reviewContextMarkdown, 'reviewContextMarkdown', [
    'review_context_markdown',
    'contextMarkdown',
    'context_markdown',
  ])
  updateField(output, previous.reviewFocus, next.reviewFocus, 'reviewFocus', ['review_focus'])
  updateField(output, previous.includePathPrefixes, next.includePathPrefixes, 'includePathPrefixes', ['include_path_prefixes'])
  updateField(output, previous.excludePathPatterns, next.excludePathPatterns, 'excludePathPatterns', ['exclude_path_patterns'])
  updateField(output, previous.maxContextBytes, next.maxContextBytes, 'maxContextBytes', ['max_context_bytes'])
  updateField(output, previous.maxFiles, next.maxFiles, 'maxFiles', ['max_files'])

  if (!sameValue(previous.ci, next.ci)) {
    const ci = isRecord(output.ci) ? { ...output.ci } : {}
    for (const key of ['maxJobLogs', 'max_job_logs', 'maxFailedJobs', 'max_failed_jobs']) delete ci[key]
    for (const key of ['maxJobLogBytes', 'max_job_log_bytes']) delete ci[key]
    ci.maxJobLogs = next.ci.maxJobLogs
    ci.maxJobLogBytes = next.ci.maxJobLogBytes
    output.ci = ci
  }
  return output
}

function canonicalProfileEntry(raw: unknown, profile: GitLabProjectProfile) {
  const output = isRecord(raw) ? { ...raw } : {}
  for (const key of [
    'id', 'host', 'projectId', 'project_id', 'nine1botProjectID', 'nine1bot_project_id',
    'pathWithNamespace', 'path_with_namespace', 'displayName', 'display_name', 'enabled',
    'reviewContextMarkdown', 'review_context_markdown', 'contextMarkdown', 'context_markdown',
    'reviewFocus', 'review_focus', 'includePathPrefixes', 'include_path_prefixes',
    'excludePathPatterns', 'exclude_path_patterns', 'maxContextBytes', 'max_context_bytes',
    'maxFiles', 'max_files', 'ci',
  ]) delete output[key]

  const rawCi = isRecord((raw as Record<string, unknown> | undefined)?.ci)
    ? { ...(raw as Record<string, unknown>).ci as Record<string, unknown> }
    : {}
  for (const key of [
    'maxJobLogs', 'max_job_logs', 'maxFailedJobs', 'max_failed_jobs',
    'maxJobLogBytes', 'max_job_log_bytes', 'enabled', 'includeFailedJobLogs', 'include_failed_job_logs',
  ]) delete rawCi[key]

  return {
    ...output,
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
      ...rawCi,
      maxJobLogs: profile.ci.maxJobLogs,
      maxJobLogBytes: profile.ci.maxJobLogBytes,
    },
  }
}

function updateField(
  output: Record<string, unknown>,
  previous: unknown,
  next: unknown,
  canonical: string,
  aliases: string[],
) {
  if (sameValue(previous, next)) return
  for (const key of [canonical, ...aliases]) delete output[key]
  if (next !== undefined) output[canonical] = next
}

function diagnostic(code: string, message: string, index: number, profileId?: string) {
  return { code, message, index, profileId }
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isProjectId(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
}

function isPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
