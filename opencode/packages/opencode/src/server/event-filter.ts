const STREAM_CONTENT_EVENTS = new Set(["message.part.updated", "message.part.delta"])

export function shouldSendEvent(
  event: { type?: string; directory?: string; payload?: { type?: string } },
  includeContent: boolean,
) {
  if (includeContent) return true
  const type = event.payload?.type ?? event.type
  return !type || !STREAM_CONTENT_EVENTS.has(type)
}
