import { describe, expect, it } from 'bun:test'
import { effectScope } from 'vue'
import { useSidebarLayout } from '../src/composables/useSidebarLayout'

function setup(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    matches,
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  } as MediaQueryList
  const scope = effectScope()
  const layout = scope.run(() => useSidebarLayout(media))!
  return {
    ...layout, scope, listeners,
    resize(matches: boolean) {
      for (const listener of listeners) listener({ matches } as MediaQueryListEvent)
    },
  }
}

describe('responsive sidebar state', () => {
  it('closes and reopens the mobile drawer without collapsing the sidebar', () => {
    const layout = setup(true)
    try {
      for (let i = 0; i < 3; i++) {
        layout.toggleSidebar()
        expect(layout.sidebarMobileOpen.value).toBe(true)
        expect(layout.sidebarCollapsed.value).toBe(false)
        layout.toggleSidebar()
        expect(layout.sidebarMobileOpen.value).toBe(false)
        expect(layout.sidebarCollapsed.value).toBe(false)
      }
    } finally { layout.scope.stop() }
  })

  it('retains desktop folding while clearing drawers across viewport changes', () => {
    const layout = setup(false)
    try {
      layout.toggleSidebar()
      expect(layout.sidebarCollapsed.value).toBe(true)
      layout.resize(true)
      expect(layout.sidebarCollapsed.value).toBe(false)
      layout.toggleSidebar()
      expect(layout.sidebarMobileOpen.value).toBe(true)
      layout.resize(false)
      expect(layout.sidebarMobileOpen.value).toBe(false)
      expect(layout.sidebarCollapsed.value).toBe(true)
      layout.resize(true)
      expect(layout.sidebarMobileOpen.value).toBe(false)
      layout.toggleSidebar()
      expect(layout.sidebarMobileOpen.value).toBe(true)
      expect(layout.sidebarCollapsed.value).toBe(false)
    } finally { layout.scope.stop() }
    expect(layout.listeners.size).toBe(0)
  })
})
