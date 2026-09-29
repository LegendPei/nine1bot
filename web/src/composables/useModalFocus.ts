import { nextTick, onMounted, onUnmounted, type Ref } from 'vue'

export function useModalFocus(root: Ref<HTMLElement | undefined>, close: () => void) {
  let previous: HTMLElement | null = null
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab' || !root.value) return
    const items = [...root.value.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
      .filter(item => item.getClientRects().length > 0)
    const first = items[0]
    const last = items[items.length - 1]
    if (!first) { event.preventDefault(); root.value.focus(); return }
    if (event.shiftKey && (document.activeElement === first || !root.value.contains(document.activeElement) || document.activeElement === root.value)) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !root.value.contains(document.activeElement))) {
      event.preventDefault(); first.focus()
    }
  }
  onMounted(async () => {
    previous = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', keydown, true)
    await nextTick()
    root.value?.focus()
  })
  onUnmounted(() => {
    document.removeEventListener('keydown', keydown, true)
    if (previous?.isConnected) previous.focus()
  })
}
