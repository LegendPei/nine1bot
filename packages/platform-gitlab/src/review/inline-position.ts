import type { GitLabChangedFile, GitLabDiffRefs, GitLabInlineValidation, ReviewFinding } from './types'

export function validateGitLabInlinePosition(
  finding: ReviewFinding,
  files: GitLabChangedFile[],
  diffRefs?: GitLabDiffRefs,
): GitLabInlineValidation {
  if (!finding.file || (!finding.newLine && !finding.oldLine)) {
    return fallback(finding, 'Finding does not include a file and diff line.')
  }

  const file = files.find((candidate) => candidate.newPath === finding.file || candidate.oldPath === finding.file)
  if (!file) return fallback(finding, 'Finding file is not part of the included diff.')

  const ranges = changedLineRanges(file.diff)
  const newLine = finding.newLine
  const oldLine = finding.oldLine
  const validNewLine = newLine !== undefined && ranges.newLines.has(newLine)
  const validOldLine = oldLine !== undefined && ranges.oldLines.has(oldLine)

  if (!validNewLine && !validOldLine) {
    return fallback(finding, `Line ${newLine ?? oldLine} is not an added or removed line in the diff hunk.`)
  }

  return {
    ok: true,
    position: {
      position_type: 'text',
      base_sha: diffRefs?.baseSha,
      start_sha: diffRefs?.startSha,
      head_sha: diffRefs?.headSha,
      old_path: file.oldPath,
      new_path: file.newPath,
      old_line: validOldLine ? oldLine : undefined,
      new_line: validNewLine ? newLine : undefined,
    },
  }
}

export function changedLineRanges(diff: string) {
  const oldLines = new Set<number>()
  const newLines = new Set<number>()
  let oldLine = 0
  let newLine = 0

  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      continue
    }
    if (!oldLine && !newLine) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      newLines.add(newLine)
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLines.add(oldLine)
      oldLine += 1
      continue
    }
    if (!line.startsWith('\\')) {
      oldLine += 1
      newLine += 1
    }
  }

  return { oldLines, newLines }
}

export function renderInlineFallbackFinding(finding: ReviewFinding, reason: string) {
  return [
    `### ${finding.title}`,
    '',
    `Inline comment fallback: ${reason}`,
    finding.file ? `File: \`${finding.file}\`${finding.newLine || finding.oldLine ? `:${finding.newLine ?? finding.oldLine}` : ''}` : undefined,
    '',
    finding.body,
  ].filter(Boolean).join('\n')
}

function fallback(finding: ReviewFinding, reason: string): GitLabInlineValidation {
  return {
    ok: false,
    reason,
    fallbackMarkdown: renderInlineFallbackFinding(finding, reason),
  }
}
