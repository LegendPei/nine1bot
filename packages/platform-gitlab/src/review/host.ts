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
