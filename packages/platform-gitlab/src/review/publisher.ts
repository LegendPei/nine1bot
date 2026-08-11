import { GitLabApiError, type GitLabApiClient } from './api-client'
import { aggregateReviewFindings } from './finding-aggregator'
import { renderReviewSummaryComment } from './comment-renderer'
import { renderInlineFindingBody, validateGitLabInlinePosition } from './inline-position'
import { gitLabReviewFindingPublicationMarkers, gitLabReviewPublicationMarker } from './publication-markers'
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

export function buildGitLabReviewPublicationPlan(input: {
  findings: ReviewFinding[]
  runId?: string
}) {
  const findings = aggregateGitLabReviewPublicationFindings(input.findings).map((finding) => ({
    finding,
    markers: input.runId
      ? gitLabReviewFindingPublicationMarkers({ runId: input.runId, finding })
      : undefined,
  }))
  return {
    summaryMarker: input.runId
      ? gitLabReviewPublicationMarker({ runId: input.runId, kind: 'summary' })
      : undefined,
    findings,
  }
}

export function isGitLabReviewPublicationComplete(input: {
  runId: string
  findings: ReviewFinding[]
  completedMarkers: ReadonlySet<string>
}) {
  const plan = buildGitLabReviewPublicationPlan({ runId: input.runId, findings: input.findings })
  if (!plan.summaryMarker || !input.completedMarkers.has(plan.summaryMarker)) return false
  return plan.findings.every(({ markers }) => Boolean(
    markers
    && (
      input.completedMarkers.has(markers.inlineMarker)
      || input.completedMarkers.has(markers.fallbackMarker)
    ),
  ))
}

export async function publishGitLabReviewResult(input: PublishGitLabReviewInput): Promise<PublishGitLabReviewResult> {
  const resource = resourceForObject(input.objectType)
  const publicationPlan = buildGitLabReviewPublicationPlan({
    findings: input.findings,
    runId: input.publication?.runId,
  })
  const aggregated = publicationPlan.findings.map(({ finding }) => finding)
  const warnings = [...(input.warnings ?? [])]
  let inlinePosted = 0
  let fallbackPosted = 0
  const inlineFindings: typeof aggregated = []
  const summaryFindings: typeof aggregated = input.inlineComments && input.objectType === 'mr' ? [] : [...aggregated]
  const summaryPublicationFindings = input.inlineComments && input.objectType === 'mr'
    ? []
    : [...publicationPlan.findings]
  const inlineCandidates: Array<{
    publicationFinding: (typeof publicationPlan.findings)[number]
    position: Record<string, unknown>
  }> = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const publicationFinding of publicationPlan.findings) {
      const finding = publicationFinding.finding
      const validation = validateGitLabInlinePosition(finding, input.manifest.files, input.manifest.diffRefs)
      if (!validation.ok) {
        summaryFindings.push(finding)
        summaryPublicationFindings.push(publicationFinding)
        fallbackPosted += 1
        warnings.push(`Inline fallback for ${finding.file ?? finding.title}: ${validation.reason}`)
        continue
      }
      inlineCandidates.push({ publicationFinding, position: validation.position })
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

  const summaryMarker = publicationPlan.summaryMarker
  const summaryFallbackMarkers = summaryPublicationFindings.flatMap(({ markers }) => {
    return markers && !isFindingCompleted(input.publication, markers) ? [markers.fallbackMarker] : []
  })
  let summaryPosted = false
  if (!isCompleted(input.publication, summaryMarker)) {
    await input.client.createNote({
      projectId: input.projectId,
      resource,
      resourceId: input.objectId,
      body: withMarkers(summaryBody, [summaryMarker, ...summaryFallbackMarkers]),
    })
    summaryPosted = true
    await completeMarker(input.publication, summaryMarker)
    for (const marker of summaryFallbackMarkers) await completeMarker(input.publication, marker)
  } else if (input.publication) {
    for (const publicationFinding of summaryPublicationFindings) {
      if (isFindingCompleted(input.publication, publicationFinding.markers)) continue
      await publishFindingFallback({
        ...input,
        resource,
        finding: publicationFinding.finding,
        marker: publicationFinding.markers?.fallbackMarker,
        warnings,
      })
      await completeMarker(input.publication, publicationFinding.markers?.fallbackMarker)
    }
  }

  if (inlineCandidates.length) {
    for (const candidate of inlineCandidates) {
      const finding = candidate.publicationFinding.finding
      const markers = candidate.publicationFinding.markers
      if (isFindingCompleted(input.publication, markers)) continue
      try {
        await input.client.createDiscussion({
          projectId: input.projectId,
          resource,
          resourceId: input.objectId,
          body: withMarkers(renderInlineFindingBody(finding), [markers?.inlineMarker]),
          position: candidate.position,
        })
        inlinePosted += 1
        await completeMarker(input.publication, markers?.inlineMarker)
      } catch (error) {
        if (error instanceof GitLabApiError && error.status === 400) {
          const detail = summarizeGitLabApiError(error)
          fallbackPosted += 1
          warnings.push(`Inline fallback for ${finding.file ?? finding.title}: GitLab API returned 400${detail ? `: ${detail}` : ''}.`)
          await publishFindingFallback({
            ...input,
            resource,
            finding,
            marker: markers?.fallbackMarker,
            warnings,
          })
          await completeMarker(input.publication, markers?.fallbackMarker)
          continue
        }
        throw error
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

function isCompleted(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  return marker !== undefined && publication?.completedMarkers.has(marker) === true
}

function isFindingCompleted(
  publication: GitLabReviewPublicationContext | undefined,
  markers: ReturnType<typeof gitLabReviewFindingPublicationMarkers> | undefined,
) {
  return Boolean(
    markers
    && (
      isCompleted(publication, markers.inlineMarker)
      || isCompleted(publication, markers.fallbackMarker)
    ),
  )
}

async function completeMarker(publication: GitLabReviewPublicationContext | undefined, marker: string | undefined) {
  if (publication && marker) await publication.onMarkerCompleted(marker)
}

async function publishFindingFallback(input: PublishGitLabReviewInput & {
  resource: 'merge_requests' | 'repository/commits'
  finding: ReturnType<typeof aggregateGitLabReviewPublicationFindings>[number]
  marker?: string
}) {
  await input.client.createNote({
    projectId: input.projectId,
    resource: input.resource,
    resourceId: input.objectId,
    body: withMarkers(renderReviewSummaryComment({
      title: 'Nine1bot Inline Publish Fallback',
      summary: 'A validated inline comment could not be posted as a GitLab diff thread after the summary was created.',
      findings: [input.finding],
      manifest: input.manifest,
      warnings: input.warnings,
    }), [input.marker]),
  })
}

function withMarkers(body: string, markers: Array<string | undefined>) {
  const completed = markers.filter((marker): marker is string => Boolean(marker))
  return completed.length > 0 ? `${body}\n\n${completed.join('\n')}` : body
}

function resourceForObject(objectType: GitLabReviewObjectType): 'merge_requests' | 'repository/commits' {
  return objectType === 'mr' ? 'merge_requests' : 'repository/commits'
}

function summarizeGitLabApiError(error: GitLabApiError) {
  const body = error.responseBody?.trim()
  if (!body) return undefined
  return body.length > 240 ? `${body.slice(0, 237)}...` : body
}
