import type { AggregatedReviewFinding, GitLabDiffManifest } from './types'

export function renderBlockedDiffComment(reason: string) {
  return [
    '⚠️ GitLab review blocked',
    '',
    reason,
    '',
    'MR diff is too large or was truncated by GitLab. Please split the MR or request a manual review.',
  ].join('\n')
}

export function renderReviewSummaryComment(input: {
  title?: string
  summary: string
  findings: AggregatedReviewFinding[]
  manifest?: GitLabDiffManifest
  warnings?: string[]
}) {
  const lines = [
    `## ${input.title ?? 'Nine1bot GitLab Review'}`,
    '',
    input.summary,
    '',
    `Findings: ${input.findings.length}`,
  ]

  if (input.manifest) {
    lines.push(
      `Diff files: ${input.manifest.stats.includedFileCount}/${input.manifest.stats.fileCount}`,
      `Skipped files: ${input.manifest.stats.skippedFileCount}`,
    )
  }

  if (input.warnings?.length) {
    lines.push('', '### Warnings', ...input.warnings.map((warning) => `- ${warning}`))
  }

  if (input.findings.length) {
    lines.push('', '### Findings')
    for (const finding of input.findings) {
      lines.push(
        `- **${finding.severity.toUpperCase()}** ${finding.file ? `\`${finding.file}${finding.newLine || finding.oldLine ? `:${finding.newLine ?? finding.oldLine}` : ''}\` ` : ''}${finding.title}`,
      )
    }
  }

  return lines.join('\n')
}
