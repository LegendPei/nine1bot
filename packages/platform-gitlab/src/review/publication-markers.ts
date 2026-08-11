import { createHash } from 'node:crypto'

import type { ReviewFinding } from './types'

const MARKER_VERSION = 'v1'
const MARKER_HASH_LENGTH = 24

export type GitLabReviewPublicationMarkerInput = {
  runId: string
  kind: 'summary' | 'inline' | 'fallback'
  findingKey?: string
}

export function gitLabReviewFindingKey(finding: ReviewFinding): string {
  return markerHash([
    finding.id ?? '',
    finding.title,
    finding.body,
    finding.severity,
    finding.category ?? '',
    finding.file ?? '',
    finding.oldLine ?? '',
    finding.newLine ?? '',
    finding.suggestion?.replacement ?? '',
    finding.suggestion?.confidence ?? '',
    finding.source ?? '',
  ])
}

export function gitLabReviewPublicationMarker(input: GitLabReviewPublicationMarkerInput): string {
  const runId = encodeURIComponent(input.runId)
  const hash = input.findingKey && /^[a-f0-9]{24}$/.test(input.findingKey)
    ? input.findingKey
    : markerHash([input.findingKey ?? input.kind])
  return `<!-- nine1bot:gitlab-review-publication:${MARKER_VERSION}:${runId}:${input.kind}:${hash} -->`
}

function markerHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, MARKER_HASH_LENGTH)
}
