import { renderReviewFindingItem, renderReviewSummaryComment } from './comment-renderer'
import type { GitLabPublishedComment } from './api-client'
import { validateGitLabInlinePosition } from './inline-position'
import { gitLabReviewPublicationMarker } from './publication-markers'
import { buildGitLabReviewPublicationPlan } from './publisher'
import type {
  GitLabDiffManifest,
  GitLabReviewObjectType,
  ReviewFinding,
} from './types'

export const GITLAB_REVIEW_LEGACY_PUBLICATION_AMBIGUOUS = 'gitlab_review_publication_legacy_ambiguous'

export class GitLabReviewPublicationCompatibilityError extends Error {
  constructor() {
    super(GITLAB_REVIEW_LEGACY_PUBLICATION_AMBIGUOUS)
  }
}

export function reconcileGitLabReviewPublicationMarkers(input: {
  runId: string
  objectType: GitLabReviewObjectType
  inlineComments: boolean
  summary: string
  findings: ReviewFinding[]
  manifest: GitLabDiffManifest
  warnings?: string[]
  notes: GitLabPublishedComment[]
  discussions: GitLabPublishedComment[]
}) {
  const plan = buildGitLabReviewPublicationPlan({ runId: input.runId, findings: input.findings })
  const summaryMarker = requiredMarker(plan.summaryMarker)
  const noteMarkers = [
    summaryMarker,
    ...plan.findings.flatMap(({ markers }) => markers ? [markers.fallbackMarker] : []),
  ]
  const inlineMarkers = plan.findings.flatMap(({ markers }) => markers ? [markers.inlineMarker] : [])
  const completed = new Set<string>([
    ...markersInComments(input.notes, noteMarkers),
    ...markersInComments(input.discussions, inlineMarkers),
  ])
  const layout = buildLegacyPublicationLayout(input, plan.findings)
  const knownNoteMarkers = new Set([
    ...noteMarkers,
    gitLabReviewPublicationMarker({ runId: input.runId, kind: 'fallback' }),
  ])

  reconcileLegacyRunFallbacks({
    runId: input.runId,
    notes: input.notes,
    manifest: input.manifest,
    candidates: layout.inlineFindings,
    knownNoteMarkers,
    completed,
  })
  reconcileLegacySummaryFindings({
    summaryMarker,
    notes: input.notes,
    summary: input.summary,
    manifest: input.manifest,
    warnings: layout.warnings,
    summaryWarnings: layout.summaryWarnings,
    summaryFindings: layout.summaryFindings,
    inlineFindings: layout.inlineFindings,
    knownNoteMarkers,
    completed,
  })

  return [
    ...(completed.has(summaryMarker) ? [summaryMarker] : []),
    ...plan.findings.flatMap(({ markers }) => {
      return markers && completed.has(markers.fallbackMarker) ? [markers.fallbackMarker] : []
    }),
    ...plan.findings.flatMap(({ markers }) => {
      return markers && completed.has(markers.inlineMarker) ? [markers.inlineMarker] : []
    }),
  ]
}

type PublicationFinding = ReturnType<typeof buildGitLabReviewPublicationPlan>['findings'][number]

function buildLegacyPublicationLayout(
  input: {
    objectType: GitLabReviewObjectType
    inlineComments: boolean
    manifest: GitLabDiffManifest
    warnings?: string[]
  },
  findings: PublicationFinding[],
) {
  const warnings = [...(input.warnings ?? [])]
  const summaryWarnings = new Map<PublicationFinding, string>()
  const summaryFindings: PublicationFinding[] = input.inlineComments && input.objectType === 'mr'
    ? []
    : [...findings]
  const inlineFindings: PublicationFinding[] = []

  if (input.inlineComments && input.objectType === 'mr') {
    for (const finding of findings) {
      const validation = validateGitLabInlinePosition(
        finding.finding,
        input.manifest.files,
        input.manifest.diffRefs,
      )
      if (validation.ok) {
        inlineFindings.push(finding)
        continue
      }
      summaryFindings.push(finding)
      summaryWarnings.set(
        finding,
        `Inline fallback for ${finding.finding.file ?? finding.finding.title}: ${validation.reason}`,
      )
    }
  } else if (input.inlineComments && input.objectType === 'commit') {
    warnings.push('Inline comments are skipped for commit review runs; findings are included in the summary comment.')
  }

  return { warnings, summaryWarnings, summaryFindings, inlineFindings }
}

function reconcileLegacyRunFallbacks(input: {
  runId: string
  notes: GitLabPublishedComment[]
  manifest: GitLabDiffManifest
  candidates: PublicationFinding[]
  knownNoteMarkers: ReadonlySet<string>
  completed: Set<string>
}) {
  const legacyMarker = gitLabReviewPublicationMarker({ runId: input.runId, kind: 'fallback' })
  const legacyNotes = input.notes.filter(({ body }) => body.includes(legacyMarker))
  for (const note of legacyNotes) {
    const body = stripKnownTrailingMarkers(note.body, input.knownNoteMarkers)
    if (body === undefined) throw new GitLabReviewPublicationCompatibilityError()
    const matched = input.candidates.filter(({ finding }) => {
      return body.includes(`\n${renderReviewFindingItem(finding)}`)
    })
    if (matched.length === 0) throw new GitLabReviewPublicationCompatibilityError()
    if (matched.some(({ finding }) => !hasLegacyFallbackWarning(body, finding))) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    const expected = renderReviewSummaryComment({
      title: 'Nine1bot Inline Publish Fallback',
      summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
      findings: matched.map(({ finding }) => finding),
      manifest: input.manifest,
    })
    if (withoutRenderedWarnings(body) !== expected) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    for (const finding of matched) {
      if (!finding.markers) throw new GitLabReviewPublicationCompatibilityError()
      input.completed.add(finding.markers.fallbackMarker)
    }
  }
}

function reconcileLegacySummaryFindings(input: {
  summaryMarker: string
  notes: GitLabPublishedComment[]
  summary: string
  manifest: GitLabDiffManifest
  warnings: string[]
  summaryWarnings: ReadonlyMap<PublicationFinding, string>
  summaryFindings: PublicationFinding[]
  inlineFindings: PublicationFinding[]
  knownNoteMarkers: ReadonlySet<string>
  completed: Set<string>
}) {
  const incomplete = input.summaryFindings.filter((finding) => !findingCompleted(finding, input.completed))
  if (incomplete.length === 0) return
  for (const { body: noteBody } of input.notes) {
    if (!noteBody.includes(input.summaryMarker)) continue
    const body = stripKnownTrailingMarkers(noteBody, input.knownNoteMarkers)
    if (body === undefined) continue
    const matched = input.summaryFindings.filter(({ finding }) => {
      return body.includes(`\n${renderReviewFindingItem(finding)}`)
    })
    const expected = renderReviewSummaryComment({
      summary: input.summary,
      findings: matched.map(({ finding }) => finding),
      inlineFindings: input.inlineFindings.map(({ finding }) => finding),
      manifest: input.manifest,
      warnings: [
        ...input.warnings,
        ...matched.flatMap((finding) => {
          const warning = input.summaryWarnings.get(finding)
          return warning ? [warning] : []
        }),
      ],
    })
    if (body !== expected) continue
    for (const finding of matched) {
      if (!finding.markers) throw new GitLabReviewPublicationCompatibilityError()
      input.completed.add(finding.markers.fallbackMarker)
    }
    return
  }
  throw new GitLabReviewPublicationCompatibilityError()
}

function markersInComments(comments: GitLabPublishedComment[], markers: string[]) {
  return markers.filter((marker) => comments.some((comment) => comment.body.includes(marker)))
}

function stripKnownTrailingMarkers(body: string, knownMarkers: ReadonlySet<string>) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  let removed = false
  while (lines.length > 0 && knownMarkers.has(lines.at(-1)!)) {
    lines.pop()
    removed = true
  }
  if (!removed) return undefined
  while (lines.at(-1) === '') lines.pop()
  return lines.join('\n')
}

function withoutRenderedWarnings(body: string) {
  const warningsHeading = '\n\n### Warnings\n'
  const warningsIndex = body.indexOf(warningsHeading)
  if (warningsIndex < 0) return body
  const nextSectionIndex = body.indexOf('\n\n### ', warningsIndex + warningsHeading.length)
  if (nextSectionIndex < 0) return body
  return `${body.slice(0, warningsIndex)}${body.slice(nextSectionIndex)}`
}

function hasLegacyFallbackWarning(body: string, finding: PublicationFinding['finding']) {
  const prefix = `- Inline fallback for ${finding.file ?? finding.title}: GitLab API returned 400`
  return body.split('\n').some((line) => line === `${prefix}.` || line.startsWith(`${prefix}: `))
}

function findingCompleted(finding: PublicationFinding, completed: ReadonlySet<string>) {
  return Boolean(
    finding.markers
    && (
      completed.has(finding.markers.inlineMarker)
      || completed.has(finding.markers.fallbackMarker)
    ),
  )
}

function requiredMarker(marker: string | undefined) {
  if (!marker) throw new GitLabReviewPublicationCompatibilityError()
  return marker
}
