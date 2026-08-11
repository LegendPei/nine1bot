import { GitLabApiError, type GitLabApiClient } from './api-client'
import { aggregateReviewFindings } from './finding-aggregator'
import { renderReviewSummaryComment } from './comment-renderer'
import { renderInlineFindingBody, validateGitLabInlinePosition } from './inline-position'
import { gitLabReviewFindingKey, gitLabReviewPublicationMarker } from './publication-markers'
import type { GitLabDiffManifest, GitLabReviewObjectType, ReviewFinding } from './types'

export type GitLabReviewPublicationContext = {
  runId: string
  completedMarkers: ReadonlySet<string>
  onMarkerCompleted(marker: string): Promise<void> | void
}

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
  publication?: GitLabReviewPublicationContext
}

export type PublishGitLabReviewResult = {
  summaryPosted: boolean
  inlinePosted: number
  fallbackPosted: number
  warnings: string[]
}

export function aggregateGitLabReviewPublicationFindings(findings: ReviewFinding[]) {
  return aggregateReviewFindings(findings)
}

export async function publishGitLabReviewResult(input: PublishGitLabReviewInput): Promise<PublishGitLabReviewResult> {
  const resource = resourceForObject(input.objectType)
  const aggregated = aggregateGitLabReviewPublicationFindings(input.findings)
  const warnings = [...(input.warnings ?? [])]
  let inlinePosted = 0
  let fallbackPosted = 0
  const inlineFindings: typeof aggregated = []
  const summaryFindings: typeof aggregated = input.inlineComments && input.objectType === 'mr' ? [] : [...aggregated]
  const inlineCandidates: Array<{ finding: (typeof aggregated)[number]; position: Record<string, unknown> }> = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const finding of aggregated) {
      const validation = validateGitLabInlinePosition(finding, input.manifest.files, input.manifest.diffRefs)
      if (!validation.ok) {
        summaryFindings.push(finding)
        fallbackPosted += 1
        warnings.push(`Inline fallback for ${finding.file ?? finding.title}: ${validation.reason}`)
        continue
      }
      inlineCandidates.push({ finding, position: validation.position })
      inlineFindings.push(finding)
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    warnings.push('Inline comments are skipped for commit review runs; findings are included in the summary comment.')
  }

  const summaryBody = [
    renderReviewSummaryComment({
      summary: input.summary,
      findings: summaryFindings,
      inlineFindings,
      manifest: input.manifest,
      warnings,
    }),
  ].filter(Boolean).join('\n')

  const summaryMarker = markerFor(input.publication, { kind: 'summary' })
  let summaryPosted = false
  if (!isCompleted(input.publication, summaryMarker)) {
    await input.client.createNote({
      projectId: input.projectId,
      resource,
      resourceId: input.objectId,
      body: withMarker(summaryBody, summaryMarker),
    })
    summaryPosted = true
    await completeMarker(input.publication, summaryMarker)
  }

  if (inlineCandidates.length) {
    const publishFallbacks: typeof aggregated = []
    for (const candidate of inlineCandidates) {
      const marker = markerFor(input.publication, {
        kind: 'inline',
        findingKey: gitLabReviewFindingKey(candidate.finding),
      })
      if (isCompleted(input.publication, marker)) continue
      try {
        await input.client.createDiscussion({
          projectId: input.projectId,
          resource,
          resourceId: input.objectId,
          body: withMarker(renderInlineFindingBody(candidate.finding), marker),
          position: candidate.position,
        })
        inlinePosted += 1
        await completeMarker(input.publication, marker)
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 400) {
          const detail = summarizeGitLabApiError(error)
          publishFallbacks.push(candidate.finding)
          fallbackPosted += 1
          warnings.push(`Inline fallback for ${candidate.finding.file ?? candidate.finding.title}: GitLab API returned 400${detail ? `: ${detail}` : ''}.`)
          continue
        }
        throw error
      }
    }
    if (publishFallbacks.length) {
      const fallbackMarker = markerFor(input.publication, { kind: 'fallback' })
      if (!isCompleted(input.publication, fallbackMarker)) {
        await input.client.createNote({
          projectId: input.projectId,
          resource,
          resourceId: input.objectId,
          body: withMarker(renderReviewSummaryComment({
            title: 'Nine1bot Inline Publish Fallback',
            summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
            findings: publishFallbacks,
            manifest: input.manifest,
            warnings,
          }), fallbackMarker),
        })
        await completeMarker(input.publication, fallbackMarker)
      }
    }
  }

  return {
    summaryPosted,
    inlinePosted,
    fallbackPosted,
    warnings,
  }
}

function markerFor(
  publication: GitLabReviewPublicationContext | undefined,
  marker: Omit<Parameters<typeof gitLabReviewPublicationMarker>[0], 'runId'>,
) {
  return publication ? gitLabReviewPublicationMarker({ runId: publication.runId, ...marker }) : undefined
}

function isCompleted(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  return marker !== undefined && publication?.completedMarkers.has(marker) === true
}

async function completeMarker(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  if (publication && marker) await publication.onMarkerCompleted(marker)
}

function withMarker(body: string, marker: string | undefined) {
  return marker ? `${body}\n\n${marker}` : body
}

function resourceForObject(objectType: GitLabReviewObjectType): 'merge_requests' | 'repository/commits' {
  return objectType === 'mr' ? 'merge_requests' : 'repository/commits'
}

function summarizeGitLabApiError(error: GitLabApiError) {
  const body = error.responseBody?.trim()
  if (!body) return undefined
  return body.length > 240 ? `${body.slice(0, 237)}...` : body
}
