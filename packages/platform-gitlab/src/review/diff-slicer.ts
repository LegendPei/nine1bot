import type { GitLabChangedFile } from './types'

export type GitLabReviewDiffSlice = { file: string; hunk: string }

export function sliceGitLabReviewDiff(files: GitLabChangedFile[], maxBytes: number) {
  const slices: GitLabReviewDiffSlice[] = []
  const omissions: Array<{ file: string; reason: 'budget-exceeded' }> = []
  let used = 0
  for (const file of files) {
    let omitted = false
    for (const hunk of splitHunks(file.diff)) {
      const bytes = new TextEncoder().encode(hunk).length
      if (used + bytes > maxBytes) {
        omitted = true
        continue
      }
      used += bytes
      slices.push({ file: file.newPath, hunk })
    }
    if (omitted) omissions.push({ file: file.newPath, reason: 'budget-exceeded' })
  }
  return { slices, omissions, usedBytes: used }
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
