import type { GitLabReviewSettings } from './settings'
import type { GitLabReviewTrigger } from './types'

export type GitLabParsedEvent =
  | { ok: true; trigger: GitLabReviewTrigger }
  | { ok: false; reason: string }

export function parseGitLabWebhookEvent(payload: unknown, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.enabled) return { ok: false, reason: 'gitlab-review-disabled' }
  if (!isRecord(payload)) return { ok: false, reason: 'invalid-payload' }

  const objectKind = stringValue(payload.object_kind)
  if (objectKind === 'merge_request') return parseMergeRequestWebhook(payload, settings)
  if (objectKind === 'note') return parseNoteWebhook(payload, settings)
  return { ok: false, reason: `unsupported-event:${objectKind ?? 'unknown'}` }
}

function parseMergeRequestWebhook(payload: Record<string, unknown>, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.webhookAutoReview) return { ok: false, reason: 'webhook-auto-review-disabled' }
  const project = recordValue(payload.project)
  const attrs = recordValue(payload.object_attributes)
  const projectId = idValue(project?.id ?? attrs?.target_project_id)
  const mrIid = idValue(attrs?.iid)
  const host = hostFromUrl(stringValue(project?.web_url) ?? stringValue(project?.git_http_url) ?? stringValue(project?.homepage))
  const headSha = stringValue(attrs?.last_commit && recordValue(attrs.last_commit)?.id) ?? stringValue(attrs?.last_commit_id) ?? stringValue(attrs?.sha)
  if (!projectId || !mrIid || !host || !headSha) return { ok: false, reason: 'missing-merge-request-identity' }
  if (!isAllowed(settings, host, projectId)) return { ok: false, reason: 'project-not-allowed' }

  return {
    ok: true,
    trigger: {
      host,
      projectId,
      projectPath: stringValue(project?.path_with_namespace),
      objectType: 'mr',
      objectIid: mrIid,
      headSha,
      eventName: 'merge_request',
      mode: 'webhook',
    },
  }
}

function parseNoteWebhook(payload: Record<string, unknown>, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.manualMentionTrigger) return { ok: false, reason: 'manual-trigger-disabled' }
  const project = recordValue(payload.project)
  const note = recordValue(payload.object_attributes)
  const mergeRequest = recordValue(payload.merge_request)
  const commit = recordValue(payload.commit)
  const noteText = stringValue(note?.note)
  const mention = noteText ? extractMentionInstruction(noteText, settings.botMention) : undefined
  if (!noteText || !mention) return { ok: false, reason: 'mention-not-found' }

  const projectId = idValue(project?.id ?? note?.project_id)
  const host = hostFromUrl(stringValue(project?.web_url) ?? stringValue(project?.git_http_url) ?? stringValue(project?.homepage))
  if (!projectId || !host) return { ok: false, reason: 'missing-project-identity' }
  if (!isAllowed(settings, host, projectId)) return { ok: false, reason: 'project-not-allowed' }

  if (mergeRequest) {
    const mrIid = idValue(mergeRequest.iid)
    const headSha = stringValue(recordValue(mergeRequest.last_commit)?.id) ?? stringValue(mergeRequest.last_commit_id) ?? stringValue(mergeRequest.sha)
    if (!mrIid || !headSha) return { ok: false, reason: 'missing-merge-request-note-identity' }
    return {
      ok: true,
      trigger: {
        host,
        projectId,
        projectPath: stringValue(project?.path_with_namespace),
        objectType: 'mr',
        objectIid: mrIid,
        headSha,
        noteId: idValue(note?.id),
        ...instructionFields(mention.instruction, note),
        eventName: 'note',
        mode: 'mention',
      },
    }
  }

  const commitSha = stringValue(commit?.id) ?? stringValue(note?.commit_id)
  if (!commitSha) return { ok: false, reason: 'missing-commit-note-identity' }
  return {
    ok: true,
    trigger: {
      host,
      projectId,
      projectPath: stringValue(project?.path_with_namespace),
      objectType: 'commit',
      commitSha,
      noteId: idValue(note?.id),
      ...instructionFields(mention.instruction, note),
      eventName: 'note',
      mode: 'mention',
    },
  }
}

function instructionFields(instruction: string | undefined, note: Record<string, unknown>) {
  if (!instruction) return {}
  return {
    userInstruction: instruction,
    instructionSource: {
      noteId: idValue(note.id),
      author: authorName(note),
      rawBody: stringValue(note.note),
    },
  }
}

export function extractMentionInstruction(noteText: string, botMention: string) {
  const mentionIndex = noteText.indexOf(botMention)
  if (mentionIndex < 0) return undefined
  const afterMention = noteText.slice(mentionIndex + botMention.length)
  const instruction = normalizeReviewInstruction(afterMention)
  return { instruction }
}

function normalizeReviewInstruction(input: string) {
  const cleaned = input
    .replace(/^[\s,，:：;；\-—]+/, '')
    .replace(/^review\b[\s,，:：;；\-—]*/i, '')
    .replace(/^please\b[\s,，:：;；\-—]*/i, '')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}...` : cleaned
}

function authorName(note: Record<string, unknown>) {
  const author = recordValue(note.author)
  return stringValue(author?.username) ?? stringValue(author?.name)
}

function isAllowed(settings: GitLabReviewSettings, host: string, projectId: string | number) {
  const hostAllowed = settings.allowedHosts.length === 0 || settings.allowedHosts.includes(host)
  const projectAllowed = settings.allowedProjectIds.length === 0 || settings.allowedProjectIds.map(String).includes(String(projectId))
  return hostAllowed && projectAllowed
}

function hostFromUrl(input?: string) {
  if (!input) return undefined
  try {
    return new URL(input).hostname
  } catch {
    return undefined
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function recordValue(input: unknown) {
  return isRecord(input) ? input : undefined
}

function stringValue(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function idValue(input: unknown): string | number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim()) return input.trim()
  return undefined
}
