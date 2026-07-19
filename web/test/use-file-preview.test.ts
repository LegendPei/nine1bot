import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { useFilePreview } from '../src/composables/useFilePreview'

// useFilePreview 使用模块级共享状态，每个用例前清空
function mockFetch() {
  const original = globalThis.fetch
  globalThis.fetch = mock(async (input: any) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.searchParams.get('path') || '/tmp/file.txt'
    return new Response(
      JSON.stringify({
        path,
        filename: path.split('/').pop(),
        mime: 'text/plain',
        content: 'aGk=',
        size: 2,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('useFilePreview', () => {
  beforeEach(() => {
    useFilePreview().closeAllPreviews()
  })

  it('generates unique preview ids even within the same millisecond', async () => {
    const restore = mockFetch()
    try {
      const { openPreviewByPath, previews } = useFilePreview()
      await openPreviewByPath('/tmp/a.txt')
      await openPreviewByPath('/tmp/a.txt')
      const ids = previews.value.map((preview) => preview.id)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
    } finally {
      restore()
    }
  })

  it('evicts the oldest previews once the 50-entry limit is exceeded', async () => {
    const restore = mockFetch()
    try {
      const { openPreviewByPath, previews, activePreviewId } = useFilePreview()
      for (let i = 0; i < 55; i++) {
        await openPreviewByPath(`/tmp/f${i}.txt`)
      }
      expect(previews.value).toHaveLength(50)
      const paths = previews.value.map((preview) => preview.path)
      // 最早的 5 条被淘汰，保留最新 50 条
      expect(paths).not.toContain('/tmp/f0.txt')
      expect(paths).not.toContain('/tmp/f4.txt')
      expect(paths[0]).toBe('/tmp/f5.txt')
      expect(paths[paths.length - 1]).toBe('/tmp/f54.txt')
      // active 指向最新打开的预览，被淘汰时不悬空
      expect(previews.value.some((preview) => preview.id === activePreviewId.value)).toBe(true)
    } finally {
      restore()
    }
  })
})
