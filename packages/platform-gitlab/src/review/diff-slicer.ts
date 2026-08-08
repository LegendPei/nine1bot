import type { GitLabChangedFile } from './types'

export type GitLabReviewDiffSlice = { file: string; hunk: string }

export function sliceGitLabReviewDiff(files: GitLabChangedFile[], maxBytes: number) {
  const slices: GitLabReviewDiffSlice[] = []
  const omissions: Array<{ file: string; reason: 'budget-exceeded' }> = []
  let used = 0
  for (const file of files) {
    let omitted = false
    for (const hunk of splitHunks(file.diff)) {
      const slice = { file: file.newPath, hunk }
      const bytes = new TextEncoder().encode(renderGitLabReviewSliceEvidence(slice, slices.length)).length
      if (used + bytes > maxBytes) {
        omitted = true
        continue
      }
      used += bytes
      slices.push(slice)
    }
    if (omitted) omissions.push({ file: file.newPath, reason: 'budget-exceeded' })
  }
  return { slices, omissions, usedBytes: used }
}

export function renderGitLabReviewSliceEvidence(slice: GitLabReviewDiffSlice, index = 0) {
  return [
    `### File ${index + 1}: ${slice.file}`,
    'Review line map for file/newLine/oldLine fields:',
    '```text',
    renderReviewLineMap(slice.hunk),
    '```',
    '',
  ].join('\n')
}

function renderReviewLineMap(diff: string) {
  const rows: string[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of diffLines(diff)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push(line)
      continue
    }
    if (!oldLine && !newLine) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push(`${lineRef(undefined, newLine)} ${line}`)
      newLine += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push(`${lineRef(oldLine, undefined)} ${line}`)
      oldLine += 1
      continue
    }
    if (!line.startsWith('\\')) {
      rows.push(`${lineRef(oldLine, newLine)} ${line}`)
      oldLine += 1
      newLine += 1
    }
  }

  return rows.join('\n')
}

function lineRef(oldLine?: number, newLine?: number) {
  return `[old:${oldLine ?? '-'} new:${newLine ?? '-'}]`
}

function diffLines(diff: string) {
  return diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
}

function splitHunks(diff: string) {
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')
  const hunks: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@') && current.length > 0) {
      hunks.push(`${current.join('\n')}\n`)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) hunks.push(`${current.join('\n')}\n`)
  return hunks
}
