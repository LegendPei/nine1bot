export function gitLabAuthorityFromUrl(input?: string) {
  if (!input) return undefined
  try {
    return new URL(input).host.toLowerCase()
  } catch {
    return undefined
  }
}

export function normalizeGitLabAuthority(input?: string) {
  if (!input?.trim()) return undefined
  const value = input.trim()
  return gitLabAuthorityFromUrl(value.includes('://') ? value : `https://${value}`)
}

export type GitLabApiBaseUrlResolution =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: 'gitlab_host_invalid' | 'gitlab_host_mismatch' }

export function resolveGitLabApiBaseUrl(input: {
  configuredBaseUrl?: string
  triggerHost: string
}): GitLabApiBaseUrlResolution {
  const triggerAuthority = normalizeGitLabAuthority(input.triggerHost)
  if (!triggerAuthority) return { ok: false, reason: 'gitlab_host_invalid' }
  if (!input.configuredBaseUrl) return { ok: true, baseUrl: `https://${triggerAuthority}` }
  if (gitLabAuthorityFromUrl(input.configuredBaseUrl) !== triggerAuthority) {
    return { ok: false, reason: 'gitlab_host_mismatch' }
  }
  return { ok: true, baseUrl: input.configuredBaseUrl.replace(/\/+$/, '') }
}
