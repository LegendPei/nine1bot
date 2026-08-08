import type { GitLabReviewProjectProfile, GitLabReviewSettings, GitLabReviewProjectSnapshot } from './settings'

export type GitLabReviewProjectTarget = {
  host: string
  projectId: string | number
  projectPath?: string
}

export type GitLabReviewProjectResolution =
  | { status: 'matched'; project: GitLabReviewProjectSnapshot }
  | { status: 'missing'; project: GitLabReviewProjectSnapshot; warning: 'project_profile_missing' }
  | { status: 'disabled'; project: GitLabReviewProjectSnapshot }

export function resolveGitLabReviewProjectProfile(
  settings: Pick<GitLabReviewSettings, 'projects'>,
  target: GitLabReviewProjectTarget,
  now = Date.now(),
): GitLabReviewProjectResolution {
  const profile = settings.projects.find((candidate) =>
    String(candidate.projectId) === String(target.projectId) && candidate.host === target.host,
  )
  if (!profile) {
    return {
      status: 'missing',
      warning: 'project_profile_missing',
      project: snapshot(unconfiguredProfile(target), 'unconfigured', now),
    }
  }
  const project = snapshot(profile, 'configured', now)
  return profile.enabled ? { status: 'matched', project } : { status: 'disabled', project }
}

function snapshot(
  profile: GitLabReviewProjectProfile,
  source: GitLabReviewProjectSnapshot['source'],
  matchedAt: number,
): GitLabReviewProjectSnapshot {
  return { ...profile, source, matchedAt }
}

function unconfiguredProfile(target: GitLabReviewProjectTarget): GitLabReviewProjectProfile {
  return {
    id: `unconfigured:${target.host}:${target.projectId}`,
    host: target.host,
    projectId: target.projectId,
    pathWithNamespace: target.projectPath,
    displayName: target.projectPath ?? String(target.projectId),
    enabled: true,
    reviewFocus: [],
    includePathPrefixes: [],
    excludePathPatterns: [],
    ci: {
      enabled: false,
      includeFailedJobLogs: true,
      maxFailedJobs: 3,
      maxJobLogBytes: 8_000,
    },
  }
}
