export type ChatViewport = { top: number; following: boolean; count: number }
const positions = new Map<string, ChatViewport>()
export function saveChatViewport(id: string | undefined, position: ChatViewport) {
  if (!id) return
  positions.delete(id)
  positions.set(id, position)
  if (positions.size > 100) positions.delete(positions.keys().next().value!)
}
export function readChatViewport(id: string | undefined) { return id ? positions.get(id) : undefined }
