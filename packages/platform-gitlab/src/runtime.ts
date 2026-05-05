import {
  asRecord,
  gitLabTemplateIdsForPage,
  isGitLabPagePayload,
  normalizeGitLabPagePayload,
  parseGitLabUrl,
} from './shared'
import { fileURLToPath } from 'node:url'
import { GitLabApiClient, GitLabApiError, type GitLabReviewSecretRef } from './review'
import { normalizeGitLabReviewSettings } from './review/settings'
import type {
  PlatformActionResult,
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformDescriptor,
  PlatformRuntimeAdapter,
  PlatformRuntimeStatus,
  PlatformSecretAccess,
  PlatformSecretRef,
  PlatformValidationResult,
} from '@nine1bot/platform-protocol'
import type { PageContextPayload, PlatformContextBlock, PlatformResourceContribution } from './types'

export type GitLabPlatformAdapter = PlatformRuntimeAdapter & {
  id: 'gitlab'
  matchPage: (page: PageContextPayload) => boolean
  normalizePage: (page: PageContextPayload) => PageContextPayload | undefined
  blocksFromPage: (page: PageContextPayload, observedAt: number) => PlatformContextBlock[] | undefined
  inferTemplateIds: (input: { entry?: { platform?: string }; page?: PageContextPayload }) => string[]
  templateContextBlocks: (input: { templateIds: string[]; page?: PageContextPayload }) => PlatformContextBlock[]
  resourceContributions: (input: { templateIds: string[] }) => PlatformResourceContribution | undefined
}

export const gitlabPlatformDescriptor = {
  id: 'gitlab',
  name: 'GitLab',
  packageName: '@nine1bot/platform-gitlab',
  version: '0.1.0',
  defaultEnabled: true,
  capabilities: {
    pageContext: true,
    templates: ['browser-gitlab', 'gitlab-repo', 'gitlab-file', 'gitlab-mr', 'gitlab-issue'],
    resources: true,
    browserExtension: true,
    auth: 'token',
    settingsPage: true,
    statusPage: true,
  },
  config: {
    sections: [
      {
        id: 'hosts',
        title: 'Access scope',
        fields: [
          {
            key: 'allowedHosts',
            type: 'string-list',
            label: 'Allowed GitLab hosts',
            description: 'GitLab hosts that can contribute page context.',
          },
          {
            key: 'apiEnrichment',
            type: 'select',
            label: 'API enrichment',
            description: 'Optionally enrich browser page context with GitLab API data.',
            options: ['auto', 'disabled'],
          },
        ],
      },
      {
        id: 'codeReview',
        title: 'Code review',
        description: 'Optional GitLab MR and commit code review automation. Disabled until explicitly enabled.',
        fields: [
          {
            key: 'review.baseUrl',
            type: 'string',
            label: 'GitLab base URL',
            description: 'Base URL for the GitLab instance, for example https://gitlab.com.',
          },
          {
            key: 'review.enabled',
            type: 'boolean',
            label: 'Enable GitLab code review',
            description: 'Allow @Nine1bot comments or configured webhooks to start GitLab review runs.',
          },
          {
            key: 'review.botMention',
            type: 'string',
            label: 'Bot mention',
            description: 'Mention text that triggers manual review from GitLab comments.',
          },
          {
            key: 'review.webhookAutoReview',
            type: 'boolean',
            label: 'Webhook auto review',
            description: 'Automatically review configured merge request webhook events.',
          },
          {
            key: 'review.modelProviderId',
            type: 'string',
            label: 'Review model provider',
            description: 'Provider selected from the configured chat model providers for GitLab review runtime runs.',
          },
          {
            key: 'review.modelId',
            type: 'string',
            label: 'Review model',
            description: 'Model selected from the configured chat models for GitLab review runtime runs.',
          },
          {
            key: 'review.inlineComments',
            type: 'boolean',
            label: 'Inline comments',
            description: 'Attempt GitLab inline discussions for validated changed lines.',
          },
          {
            key: 'review.dryRun',
            type: 'boolean',
            label: 'Dry run',
            description: 'Build review context without writing comments back to GitLab.',
          },
          {
            key: 'review.allowedProjectIds',
            type: 'string-list',
            label: 'Allowed project ids',
            description: 'GitLab project ids allowed to trigger review runs.',
          },
          {
            key: 'review.webhookSecretRef',
            type: 'password',
            label: 'Webhook secret',
            description: 'Secret embedded in the dedicated GitLab webhook URL, or used to validate X-Gitlab-Token when calling /webhooks/gitlab.',
            secret: true,
          },
          {
            key: 'review.tokenSecretRef',
            type: 'password',
            label: 'GitLab API token',
            description: 'GitLab account token used to read diffs and write review comments.',
            secret: true,
          },
        ],
      },
    ],
  },
  detailPage: {
    sections: [
      { id: 'status', type: 'status-cards', title: 'Status' },
      { id: 'settings', type: 'settings-form', title: 'Settings' },
      { id: 'actions', type: 'action-list', title: 'Actions' },
      { id: 'recent-events', type: 'event-list', title: 'Recent events' },
    ],
  },
  actions: [
    {
      id: 'connection.test',
      label: 'Test connection',
      kind: 'button',
    },
  ],
} satisfies PlatformDescriptor

export const gitlabPlatformContribution = {
  descriptor: gitlabPlatformDescriptor,
  runtime: {
    createAdapter: createGitLabPlatformAdapter,
    sources: {
      agents: [
        {
          id: 'gitlab-review-agents',
          directory: fileURLToPath(new URL('../agents', import.meta.url)),
          namespace: 'platform.gitlab',
          visibility: 'recommendable',
          lifecycle: 'platform-enabled',
        },
      ],
      skills: [
        {
          id: 'gitlab-review-skills',
          directory: fileURLToPath(new URL('../skills', import.meta.url)),
          namespace: 'platform.gitlab',
          visibility: 'declared-only',
          lifecycle: 'platform-enabled',
        },
      ],
    },
  },
  getStatus: getGitLabPlatformStatus,
  validateConfig: validateGitLabPlatformConfig,
  handleAction: handleGitLabPlatformAction,
} satisfies PlatformAdapterContribution

export function createGitLabPlatformAdapter(): GitLabPlatformAdapter {
  return {
    id: 'gitlab',
    matchPage: isGitLabPagePayload,
    normalizePage: normalizeGitLabPagePayload,
    blocksFromPage: buildGitLabContextBlocks,
    inferTemplateIds(input) {
      if (input.entry?.platform !== 'gitlab' && !input.page) return []
      const ids = gitLabTemplateIdsForPage(input.page)
      return ids.length > 0 || input.entry?.platform !== 'gitlab' ? ids : ['browser-gitlab']
    },
    templateContextBlocks(input) {
      return buildGitLabTemplateContextBlocks(input.templateIds, input.page)
    },
    resourceContributions(input) {
      if (!input.templateIds.some((templateId) => templateId === 'browser-gitlab' || templateId.startsWith('gitlab-'))) {
        return undefined
      }
      return emptyResources(['gitlab-context'])
    },
    recommendedAgent(input) {
      return input.templateIds.includes('gitlab-mr') ? 'platform.gitlab.pm-coordinator' : input.fallback
    },
  }
}

export { gitLabTemplateIdsForPage, normalizeGitLabPagePayload, parseGitLabUrl }

async function getGitLabPlatformStatus(ctx: PlatformAdapterContext): Promise<PlatformRuntimeStatus> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const cards: PlatformRuntimeStatus['cards'] = [
    { id: 'context', label: 'Page context', value: 'enabled', tone: 'success' },
    { id: 'review', label: 'Code review', value: settings.enabled ? 'enabled' : 'disabled', tone: settings.enabled ? 'success' : 'neutral' },
    { id: 'mode', label: 'Review mode', value: settings.executionMode, tone: settings.dryRun ? 'warning' : 'neutral' },
    { id: 'model', label: 'Review model', value: settings.modelProviderId && settings.modelId ? `${settings.modelProviderId}/${settings.modelId}` : 'default', tone: 'neutral' },
  ]

  if (!settings.enabled) {
    return {
      status: 'available',
      message: 'GitLab page context is available. Code review is disabled until enabled in settings.',
      cards,
    }
  }

  if (!settings.tokenSecretRef) {
    return {
      status: 'auth-required',
      message: 'GitLab code review is enabled but no API token is configured.',
      cards,
    }
  }

  const tokenConfigured = typeof settings.tokenSecretRef === 'string' || await ctx.secrets.has(settings.tokenSecretRef)
  if (!tokenConfigured) {
    return {
      status: 'auth-required',
      message: 'GitLab code review token is missing or unavailable.',
      cards,
    }
  }

  return {
    status: settings.dryRun ? 'degraded' : 'available',
    message: settings.dryRun
      ? 'GitLab code review is configured in dry-run mode; no comments will be written.'
      : 'GitLab code review is configured.',
    cards,
  }
}

async function validateGitLabPlatformConfig(settingsInput: unknown): Promise<PlatformValidationResult> {
  const settings = normalizeGitLabReviewSettings(settingsInput)
  const fieldErrors: Record<string, string> = {}

  if (settings.enabled) {
    if (!settings.tokenSecretRef) fieldErrors['review.tokenSecretRef'] = 'GitLab API token is required when code review is enabled.'
    if (settings.baseUrl && !isHttpUrl(settings.baseUrl)) fieldErrors['review.baseUrl'] = 'GitLab base URL must be an http(s) URL.'
    if (!settings.botMention.trim().startsWith('@')) fieldErrors['review.botMention'] = 'Bot mention must start with @.'
    if (settings.modelProviderId && !settings.modelId) fieldErrors['review.modelId'] = 'Review model is required when a review model provider is set.'
    if (!settings.modelProviderId && settings.modelId) fieldErrors['review.modelProviderId'] = 'Review model provider is required when a review model is set.'
  }

  return Object.keys(fieldErrors).length
    ? { ok: false, message: 'Invalid GitLab code review settings.', fieldErrors }
    : { ok: true }
}

async function handleGitLabPlatformAction(
  actionId: string,
  _input: unknown,
  ctx: PlatformAdapterContext,
): Promise<PlatformActionResult> {
  if (actionId !== 'connection.test') {
    return { status: 'failed', message: `Unsupported GitLab action: ${actionId}` }
  }

  const status = await getGitLabPlatformStatus(ctx)
  if (status.status === 'auth-required' || status.status === 'error') {
    return { status: 'failed', message: status.message, updatedStatus: status }
  }
  return await testGitLabConnection(ctx, status)
}

async function testGitLabConnection(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) {
    return { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status }
  }

  try {
    const client = new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    })
    const self = await client.getTokenSelf()
    const scopes = Array.isArray(self.scopes) ? self.scopes : []
    const active = self.active !== false && self.revoked !== true
    if (!active) {
      return { status: 'failed', message: 'GitLab API token is revoked or inactive.', updatedStatus: status }
    }
    if (!scopes.includes('api')) {
      return {
        status: 'failed',
        message: `GitLab API token is reachable but missing required api scope. Current scopes: ${scopes.join(', ') || 'unknown'}.`,
        updatedStatus: status,
      }
    }
    return {
      status: 'ok',
      message: `GitLab API token is reachable${self.name ? ` (${self.name})` : ''} and includes api scope.`,
      updatedStatus: status,
    }
  } catch (error) {
    if (error instanceof GitLabApiError) {
      return {
        status: 'failed',
        message: `GitLab API token check failed: ${error.status} ${error.statusText}.`,
        updatedStatus: status,
      }
    }
    return {
      status: 'failed',
      message: `GitLab API token check failed: ${error instanceof Error ? error.message : String(error)}.`,
      updatedStatus: status,
    }
  }
}

async function resolveGitLabReviewSecret(
  ref: GitLabReviewSecretRef | undefined,
  secrets: PlatformSecretAccess,
): Promise<string | undefined> {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref satisfies PlatformSecretRef)
}

function buildGitLabContextBlocks(page: PageContextPayload, observedAt: number): PlatformContextBlock[] | undefined {
  const adapted = normalizeGitLabPagePayload(page)
  if (!adapted) return undefined
  const gitlab = asRecord(adapted.raw?.gitlab)
  const pageType = adapted.pageType ?? 'gitlab-repo'
  const mergeKey = pageKeyFor(adapted)
  const blocks: PlatformContextBlock[] = [
    {
      id: 'platform:gitlab',
      layer: 'platform',
      source: 'page-context.gitlab',
      content: renderPlatform(adapted, gitlab),
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 65,
      mergeKey,
      observedAt,
    },
    {
      id: `page:${pageType}`,
      layer: 'page',
      source: 'page-context.gitlab',
      content: renderPage(adapted, gitlab),
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 62,
      mergeKey,
      observedAt,
    },
  ]

  if (adapted.selection?.trim()) {
    blocks.push({
      id: `page:browser-selection:${textDigest(adapted.selection).slice(0, 12)}`,
      layer: 'page',
      source: 'page-context.gitlab.selection',
      content: `Current page selection:\n${adapted.selection.trim()}`,
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 55,
      mergeKey: `${mergeKey}:selection`,
      observedAt,
    })
  }

  return blocks
}

function buildGitLabTemplateContextBlocks(templateIds: string[], page?: PageContextPayload): PlatformContextBlock[] {
  const normalizedPage = page ? normalizeGitLabPagePayload(page) : undefined
  const blocks: PlatformContextBlock[] = []
  for (const templateId of templateIds) {
    if (templateId === 'browser-gitlab') {
      blocks.push({
        id: 'template:browser-gitlab',
        layer: 'platform',
        source: 'template.browser-gitlab',
        content: 'This session can use GitLab browser context. Treat GitLab repository, file, merge request, and issue page events as active work context.',
        lifecycle: 'session',
        visibility: 'developer-toggle',
        enabled: true,
        priority: 45,
      })
    }
    if (templateId.startsWith('gitlab-')) {
      blocks.push({
        id: `template:${templateId}`,
        layer: 'platform',
        source: `template.${templateId}`,
        content: renderGitLabTemplateContext(templateId, normalizedPage),
        lifecycle: 'session',
        visibility: 'developer-toggle',
        enabled: true,
        priority: 42,
        mergeKey: normalizedPage?.objectKey,
      })
    }
  }
  return blocks
}

function renderGitLabTemplateContext(templateId: string, page?: PageContextPayload) {
  return [
    `GitLab template: ${templateId}`,
    page?.title ? `Initial page title: ${page.title}` : undefined,
    page?.url ? `Initial page URL: ${page.url}` : undefined,
    page?.objectKey ? `Initial object key: ${page.objectKey}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderPlatform(page: PageContextPayload, gitlab?: Record<string, unknown>) {
  return [
    'Platform: GitLab',
    page.title ? `Title: ${page.title}` : undefined,
    page.url ? `URL: ${page.url}` : undefined,
    stringValue(gitlab?.host) ? `Host: ${gitlab?.host}` : undefined,
    stringValue(gitlab?.projectPath) ? `Project path: ${gitlab?.projectPath}` : undefined,
    page.visibleSummary ? `Visible summary:\n${page.visibleSummary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderPage(page: PageContextPayload, gitlab?: Record<string, unknown>) {
  return [
    `Page type: ${page.pageType ?? 'gitlab-repo'}`,
    page.objectKey ? `Object key: ${page.objectKey}` : undefined,
    stringValue(gitlab?.route) ? `GitLab route: ${gitlab?.route}` : undefined,
    stringValue(gitlab?.iid) ? `IID: ${gitlab?.iid}` : undefined,
    stringValue(gitlab?.ref) ? `Ref: ${gitlab?.ref}` : undefined,
    stringValue(gitlab?.filePath) ? `File path: ${gitlab?.filePath}` : undefined,
    stringValue(gitlab?.treePath) ? `Tree path: ${gitlab?.treePath}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function emptyResources(enabledGroups: string[]): PlatformResourceContribution {
  return {
    builtinTools: {
      enabledGroups,
    },
    mcp: {
      servers: [],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
    skills: {
      skills: [],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
  }
}

function pageKeyFor(page: PageContextPayload) {
  return [page.platform, page.pageType || 'page', page.objectKey || page.url || page.title || 'unknown'].join(':')
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function isHttpUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function textDigest(input: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
