import { GitLabApiError, type GitLabApiClient } from './api-client'
import { aggregateReviewFindings } from './finding-aggregator'
import { renderReviewSummaryComment } from './comment-renderer'
import { renderInlineFallbackFinding, renderInlineFindingBody, validateGitLabInlinePosition } from './inline-position'
import type { GitLabDiffManifest, GitLabReviewObjectType, ReviewFinding } from './types'

export type PublishGitLabReviewInput = {
  client: Pick<GitLabApiClient, 'createNote' | 'createDiscussion'>
  projectId: string | number
  objectType: GitLabReviewObjectType
  objectId: string | number
  manifest: GitLabDiffManifest
  summary: string
  findings: ReviewFinding[]
  inlineComments: boolean
  warnings?: string[]
}

export type PublishGitLabReviewResult = {
  summaryPosted: boolean
  inlinePosted: number
  fallbackPosted: number
  warnings: string[]
}

export async function publishGitLabReviewResult(input: PublishGitLabReviewInput): Promise<PublishGitLabReviewResult> {
  const resource = resourceForObject(input.objectType)
  const aggregated = aggregateReviewFindings(input.findings)
  const warnings = [...(input.warnings ?? [])]
  let inlinePosted = 0
  let fallbackPosted = 0
  const fallbackMarkdown: string[] = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const finding of aggregated) {
      const validation = validateGitLabInlinePosition(finding, input.manifest.files, input.manifest.diffRefs)
      if (!validation.ok) {
        fallbackMarkdown.push(validation.fallbackMarkdown)
        fallbackPosted += 1
        warnings.push(`Inline fallback for ${finding.file ?? finding.title}: ${validation.reason}`)
        continue
      }
      try {
        await input.client.createDiscussion({
          projectId: input.projectId,
          resource,
          resourceId: input.objectId,
          body: renderInlineFindingBody(finding),
          position: validation.position,
        })
        inlinePosted += 1
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 400) {
          const detail = summarizeGitLabApiError(error)
          fallbackMarkdown.push(renderInlineFallbackFinding(finding, detail ? `GitLab rejected the inline discussion position: ${detail}` : 'GitLab rejected the inline discussion position.'))
          fallbackPosted += 1
          warnings.push(`Inline fallback for ${finding.file ?? finding.title}: GitLab API returned 400${detail ? `: ${detail}` : ''}.`)
          continue
        }
        throw error
      }
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    warnings.push('Inline comments are skipped for commit review runs; findings are included in the summary comment.')
  }

  const summaryBody = [
    renderReviewSummaryComment({
      summary: input.summary,
      findings: aggregated,
      manifest: input.manifest,
      warnings,
    }),
    fallbackMarkdown.length ? ['', '### Inline Fallbacks', '', fallbackMarkdown.join('\n\n')].join('\n') : undefined,
  ].filter(Boolean).join('\n')

  await input.client.createNote({
    projectId: input.projectId,
    resource,
    resourceId: input.objectId,
    body: summaryBody,
  })

  return {
    summaryPosted: true,
    inlinePosted,
    fallbackPosted,
    warnings,
  }
}

function resourceForObject(objectType: GitLabReviewObjectType): 'merge_requests' | 'repository/commits' {
  return objectType === 'mr' ? 'merge_requests' : 'repository/commits'
}

function summarizeGitLabApiError(error: GitLabApiError) {
  const body = error.responseBody?.trim()
  if (!body) return undefined
  return body.length > 240 ? `${body.slice(0, 237)}...` : body
}
