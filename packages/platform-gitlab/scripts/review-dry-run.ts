import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  aggregateReviewFindings,
  buildGitLabDiffManifest,
  buildGitLabReviewIdempotencyKey,
  renderBlockedDiffComment,
  renderReviewSummaryComment,
  validateGitLabInlinePosition,
  type GitLabRawChangesResponse,
  type ReviewFinding,
} from '../src/review'

const fixturePath = resolve(process.cwd(), process.argv[2] ?? 'fixtures/review/sample-mr-changes.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as GitLabRawChangesResponse
const manifest = buildGitLabDiffManifest(fixture)

const idempotencyKey = buildGitLabReviewIdempotencyKey({
  host: 'gitlab.example.com',
  projectId: 1,
  objectType: 'mr',
  objectIid: 10,
  headSha: manifest.diffRefs?.headSha ?? 'dry-run-head',
  mode: 'webhook',
  eventName: 'merge_request',
})

if (manifest.blocked) {
  console.log(JSON.stringify({
    idempotencyKey,
    blocked: true,
    comment: renderBlockedDiffComment(manifest.blockReason ?? 'Diff blocked.'),
  }, null, 2))
  process.exit(0)
}

const syntheticFindings: ReviewFinding[] = [
  {
    title: 'Permission check changed',
    body: 'Dry-run fixture detected a changed authorization decision line.',
    severity: 'major',
    category: 'auth',
    file: 'src/auth.ts',
    newLine: 3,
    source: 'dry-run',
  },
]

const inline = validateGitLabInlinePosition(syntheticFindings[0]!, manifest.files, manifest.diffRefs)
const findings = aggregateReviewFindings(syntheticFindings)
const comment = renderReviewSummaryComment({
  summary: 'Dry-run completed without calling GitLab or Runtime.',
  findings,
  manifest,
  warnings: inline.ok ? [] : [inline.reason],
})

console.log(JSON.stringify({
  idempotencyKey,
  blocked: false,
  manifest,
  inline,
  comment,
}, null, 2))
