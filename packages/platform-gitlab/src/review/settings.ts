export type GitLabReviewSettings = {
  enabled: boolean
  baseUrl?: string
  botMention: string
  allowedHosts: string[]
  allowedProjectIds: Array<string | number>
  webhookSecretRef?: GitLabReviewSecretRef
  tokenSecretRef?: GitLabReviewSecretRef
  webhookSourceId?: string
  manualMentionTrigger: boolean
  webhookAutoReview: boolean
  inlineComments: boolean
  dryRun: boolean
  maxDiffBytes: number
  maxFiles: number
  executionMode: 'dry-run' | 'runtime'
  modelProviderId?: string
  modelId?: string
}

export type GitLabReviewSecretRef = string | {
  provider: 'nine1bot-local' | 'env' | 'external'
  key: string
}

export const defaultGitLabReviewSettings: GitLabReviewSettings = {
  enabled: false,
  baseUrl: undefined,
  botMention: '@Nine1bot',
  allowedHosts: [],
  allowedProjectIds: [],
  manualMentionTrigger: true,
  webhookAutoReview: false,
  inlineComments: true,
  dryRun: true,
  maxDiffBytes: 240_000,
  maxFiles: 80,
  executionMode: 'dry-run',
  modelProviderId: undefined,
  modelId: undefined,
}

export function normalizeGitLabReviewSettings(input: unknown): GitLabReviewSettings {
  const record = isRecord(input) ? input : {}
  return {
    ...defaultGitLabReviewSettings,
    enabled: booleanValue(setting(record, 'review.enabled', 'enabled'), defaultGitLabReviewSettings.enabled),
    baseUrl: optionalString(setting(record, 'review.baseUrl', 'baseUrl')),
    botMention: stringValue(setting(record, 'review.botMention', 'botMention'), defaultGitLabReviewSettings.botMention),
    allowedHosts: stringList(setting(record, 'allowedHosts')),
    allowedProjectIds: idList(setting(record, 'review.allowedProjectIds', 'allowedProjectIds')),
    webhookSecretRef: optionalSecretRef(setting(record, 'review.webhookSecretRef', 'webhookSecretRef')),
    tokenSecretRef: optionalSecretRef(setting(record, 'review.tokenSecretRef', 'tokenSecretRef')),
    webhookSourceId: optionalString(setting(record, 'review.webhookSourceId', 'webhookSourceId')),
    manualMentionTrigger: booleanValue(setting(record, 'review.manualMentionTrigger', 'manualMentionTrigger'), defaultGitLabReviewSettings.manualMentionTrigger),
    webhookAutoReview: booleanValue(setting(record, 'review.webhookAutoReview', 'webhookAutoReview'), defaultGitLabReviewSettings.webhookAutoReview),
    inlineComments: booleanValue(setting(record, 'review.inlineComments', 'inlineComments'), defaultGitLabReviewSettings.inlineComments),
    dryRun: booleanValue(setting(record, 'review.dryRun', 'dryRun'), defaultGitLabReviewSettings.dryRun),
    maxDiffBytes: positiveNumber(setting(record, 'review.maxDiffBytes', 'maxDiffBytes'), defaultGitLabReviewSettings.maxDiffBytes),
    maxFiles: positiveNumber(setting(record, 'review.maxFiles', 'maxFiles'), defaultGitLabReviewSettings.maxFiles),
    executionMode: setting(record, 'review.executionMode', 'executionMode') === 'runtime' ? 'runtime' : 'dry-run',
    modelProviderId: optionalString(setting(record, 'review.modelProviderId', 'modelProviderId')),
    modelId: optionalString(setting(record, 'review.modelId', 'modelId')),
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
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

function idList(input: unknown) {
  return Array.isArray(input)
    ? input.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    : []
}

function positiveNumber(input: unknown, fallback: number) {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : fallback
}

function setting(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
  }
  return undefined
}
