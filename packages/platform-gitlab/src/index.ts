export {
  buildGitLabPageContextPayload,
  buildGitLabPageContextPayload as buildPageContextPayload,
  gitLabTemplateIdsForPage,
  isGitLabPagePayload,
  parseGitLabUrl,
} from './browser'
export {
  createGitLabPlatformAdapter,
  gitlabPlatformContribution,
  gitlabPlatformDescriptor,
  normalizeGitLabPagePayload,
} from './runtime'
export type { GitLabPlatformAdapter } from './runtime'
export * from './review'
export type * from './types'
