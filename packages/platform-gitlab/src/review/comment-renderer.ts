import type { AggregatedReviewFinding, GitLabChangedFile, GitLabDiffManifest } from './types'

export function renderBlockedDiffComment(reason: string) {
  return [
    'GitLab review blocked',
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
    for (const group of groupFindingsByFile(input.findings)) {
      lines.push('', `#### ${group.file ? `\`${group.file}\`` : 'General'}`)
      for (const finding of group.findings) {
        const location = finding.newLine || finding.oldLine ? `:${finding.newLine ?? finding.oldLine}` : ''
        lines.push(
          '',
          `- **${finding.severity.toUpperCase()}** ${finding.title}${location ? ` (${location})` : ''}`,
          '',
          finding.body,
        )
        if (finding.sources.length > 1) {
          lines.push('', `Sources: ${finding.sources.map((source) => `\`${source}\``).join(', ')}`)
        }
        const snippet = input.manifest ? diffSnippetForFinding(finding, input.manifest.files) : undefined
        if (snippet) {
          const fence = markdownFence(snippet)
          lines.push('', 'Evidence:', '', `${fence}diff`, snippet, fence)
        }
      }
    }
  }

  return lines.join('\n')
}

function groupFindingsByFile(findings: AggregatedReviewFinding[]) {
  const groups = new Map<string, { file?: string; findings: AggregatedReviewFinding[] }>()
  for (const finding of findings) {
    const key = finding.file ?? '__general__'
    const existing = groups.get(key)
    if (existing) {
      existing.findings.push(finding)
      continue
    }
    groups.set(key, {
      file: finding.file,
      findings: [finding],
    })
  }
  return Array.from(groups.values())
}

function diffSnippetForFinding(finding: AggregatedReviewFinding, files: GitLabChangedFile[]) {
  if (!finding.file) return undefined
  const file = files.find((candidate) => candidate.newPath === finding.file || candidate.oldPath === finding.file)
  if (!file) return undefined
  return diffSnippet(file.diff, {
    newLine: finding.newLine,
    oldLine: finding.oldLine,
  })
}

export function diffSnippet(diff: string, input: { newLine?: number; oldLine?: number } = {}) {
  const hunks = parseDiffHunks(diff)
  if (!hunks.length) return undefined
  const matched = hunks.find((hunk) => {
    if (input.newLine !== undefined && hunk.newChangedLines.has(input.newLine)) return true
    if (input.oldLine !== undefined && hunk.oldChangedLines.has(input.oldLine)) return true
    return false
  }) ?? hunks[0]
  return trimSnippet(matched.lines)
}

function parseDiffHunks(diff: string) {
  const hunks: Array<{
    lines: string[]
    oldChangedLines: Set<number>
    newChangedLines: Set<number>
  }> = []
  let current: (typeof hunks)[number] | undefined
  let oldLine = 0
  let newLine = 0

  for (const line of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      current = {
        lines: [line],
        oldChangedLines: new Set(),
        newChangedLines: new Set(),
      }
      hunks.push(current)
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (!current) continue
    current.lines.push(line)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.newChangedLines.add(newLine)
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.oldChangedLines.add(oldLine)
      oldLine += 1
      continue
    }
    if (!line.startsWith('\\')) {
      oldLine += 1
      newLine += 1
    }
  }

  return hunks
}

function trimSnippet(lines: string[], maxLines = 16, maxChars = 1800) {
  const trimmed = lines.slice(0, maxLines)
  if (lines.length > maxLines) trimmed.push('...')
  let text = trimmed.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars).trimEnd()}\n...`
  return text
}

function markdownFence(content: string) {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g)).map((match) => match[0].length))
  return '`'.repeat(longest + 1)
}
