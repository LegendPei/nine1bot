import { computed, onScopeDispose, ref } from 'vue'

// Keep this breakpoint aligned with the sidebar media query in style.css.
export function useSidebarLayout(media = typeof window === 'undefined'
  ? undefined
  : window.matchMedia('(max-width: 768px)')) {
  const isMobile = ref(media?.matches ?? false)
  const desktopCollapsed = ref(false)
  const sidebarMobileOpen = ref(false)
  const sidebarCollapsed = computed(() => !isMobile.value && desktopCollapsed.value)

  function onViewportChange(event: MediaQueryListEvent) {
    isMobile.value = event.matches
    sidebarMobileOpen.value = false
  }

  function toggleSidebar() {
    if (isMobile.value) sidebarMobileOpen.value = !sidebarMobileOpen.value
    else desktopCollapsed.value = !desktopCollapsed.value
  }

  media?.addEventListener('change', onViewportChange)
  onScopeDispose(() => media?.removeEventListener('change', onViewportChange))

  return { sidebarCollapsed, sidebarMobileOpen, toggleSidebar }
}
