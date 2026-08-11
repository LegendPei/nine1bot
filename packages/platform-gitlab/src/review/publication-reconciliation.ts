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
    warnings: [
      ...layout.warnings,
      ...layout.summaryFindings.flatMap((finding) => {
        const warning = layout.summaryWarnings.get(finding)
        return warning ? [warning] : []
      }),
    ],
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
  warnings: string[]
  knownNoteMarkers: ReadonlySet<string>
  completed: Set<string>
}) {
  const legacyMarker = gitLabReviewPublicationMarker({ runId: input.runId, kind: 'fallback' })
  const legacyNotes = input.notes.filter(({ body }) => body.includes(legacyMarker))
  for (const note of legacyNotes) {
    const body = stripKnownTrailingMarkers(note.body, input.knownNoteMarkers)
    if (body === undefined || containsKnownMarker(body, input.knownNoteMarkers)) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    const matched = input.candidates.filter(({ finding }) => {
      return body.includes(`\n${renderReviewFindingItem(finding)}`)
    })
    if (matched.length === 0) throw new GitLabReviewPublicationCompatibilityError()
    const expected = renderReviewSummaryComment({
      title: 'Nine1bot Inline Publish Fallback',
      summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
      findings: matched.map(({ finding }) => finding),
      manifest: input.manifest,
    })
    const dynamicWarnings = legacyFallbackDynamicWarnings({
      body,
      expectedWithoutWarnings: expected,
      fixedWarnings: input.warnings,
      findings: matched,
    })
    if (!dynamicWarnings) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
    const roundTrip = renderReviewSummaryComment({
      title: 'Nine1bot Inline Publish Fallback',
      summary: 'Some validated inline comments could not be posted as GitLab diff threads after the summary was created.',
      findings: matched.map(({ finding }) => finding),
      manifest: input.manifest,
      warnings: [...input.warnings, ...dynamicWarnings],
    })
    if (body !== roundTrip) throw new GitLabReviewPublicationCompatibilityError()
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
  let matchedAny = false
  for (const { body: noteBody } of input.notes) {
    if (!noteBody.includes(input.summaryMarker)) continue
    const body = stripKnownTrailingMarkers(noteBody, input.knownNoteMarkers)
    if (body === undefined || containsKnownMarker(body, input.knownNoteMarkers)) {
      throw new GitLabReviewPublicationCompatibilityError()
    }
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
    if (body !== expected) throw new GitLabReviewPublicationCompatibilityError()
    matchedAny = true
    for (const finding of matched) {
      if (!finding.markers) throw new GitLabReviewPublicationCompatibilityError()
      input.completed.add(finding.markers.fallbackMarker)
    }
  }
  if (!matchedAny) throw new GitLabReviewPublicationCompatibilityError()
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

function containsKnownMarker(body: string, knownMarkers: ReadonlySet<string>) {
  return Array.from(knownMarkers).some((marker) => body.includes(marker))
}

function legacyFallbackDynamicWarnings(input: {
  body: string
  expectedWithoutWarnings: string
  fixedWarnings: string[]
  findings: PublicationFinding[]
}) {
  const findingsHeading = '\n\n### Findings'
  const findingsIndex = input.expectedWithoutWarnings.indexOf(findingsHeading)
  if (findingsIndex < 0) return undefined
  const bodyPrefix = `${input.expectedWithoutWarnings.slice(0, findingsIndex)}\n\n### Warnings\n`
  const bodySuffix = input.expectedWithoutWarnings.slice(findingsIndex)
  if (!input.body.startsWith(bodyPrefix) || !input.body.endsWith(bodySuffix)) return undefined

  const warningSection = input.body.slice(bodyPrefix.length, input.body.length - bodySuffix.length)
  const fixedSection = input.fixedWarnings.map((warning) => `- ${warning}`).join('\n')
  let dynamicSection = warningSection
  if (fixedSection) {
    if (!warningSection.startsWith(`${fixedSection}\n`)) return undefined
    dynamicSection = warningSection.slice(fixedSection.length + 1)
  }
  return parseLegacyFallbackDynamicWarnings(dynamicSection, input.findings)
}

function parseLegacyFallbackDynamicWarnings(section: string, findings: PublicationFinding[]) {
  const memo = new Map<string, string[] | null>()

  const parseAt = (findingIndex: number, position: number): string[] | undefined => {
    const key = `${findingIndex}:${position}`
    const cached = memo.get(key)
    if (cached !== undefined) return cached ?? undefined
    if (findingIndex === findings.length) {
      const result = position === section.length ? [] : undefined
      memo.set(key, result ?? null)
      return result
    }

    let warningStart = position
    if (findingIndex > 0) {
      if (section[warningStart] !== '\n') {
        memo.set(key, null)
        return undefined
      }
      warningStart += 1
    }
    const finding = findings[findingIndex]!.finding
    const warningPrefix = `Inline fallback for ${finding.file ?? finding.title}: GitLab API returned 400`
    const renderedPrefix = `- ${warningPrefix}`
    if (!section.startsWith(renderedPrefix, warningStart)) {
      memo.set(key, null)
      return undefined
    }
    const suffixStart = warningStart + renderedPrefix.length
    const candidates: Array<{ end: number; warning: string }> = []
    if (section[suffixStart] === '.') {
      candidates.push({ end: suffixStart + 1, warning: `${warningPrefix}.` })
    }
    if (section.startsWith(': ', suffixStart)) {
      const detailStart = suffixStart + 2
      const detailLimit = Math.min(section.length, detailStart + 240)
      for (let terminal = detailStart + 1; terminal <= detailLimit; terminal += 1) {
        if (section[terminal] !== '.') continue
        const detail = section.slice(detailStart, terminal)
        if (detail.trim() !== detail || detail.includes('\n- ')) continue
        candidates.push({
          end: terminal + 1,
          warning: `${warningPrefix}: ${detail}.`,
        })
      }
    }

    for (const candidate of candidates) {
      const remaining = parseAt(findingIndex + 1, candidate.end)
      if (!remaining) continue
      const result = [candidate.warning, ...remaining]
      memo.set(key, result)
      return result
    }
    memo.set(key, null)
    return undefined
  }

  return parseAt(0, 0)
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
