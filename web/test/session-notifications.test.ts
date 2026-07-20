import { describe, expect, it } from 'bun:test'
import { compile } from 'vue'

describe('session notifications', () => {
  it('renders a page-level error surface with complete scrollable error text', async () => {
    const source = await Bun.file(new URL('../src/components/SessionNotifications.vue', import.meta.url)).text()
    const templateStart = source.indexOf('<template>')
    const templateEnd = source.lastIndexOf('</template>')
    const template = source.slice(templateStart + '<template>'.length, templateEnd)

    expect(() => compile(template)).not.toThrow()
    expect(source).toContain('会话「${notification.sessionTitle}」运行失败')
    expect(source).toContain('white-space: pre-wrap')
    expect(source).toContain('overflow-wrap: anywhere')
    expect(source).toContain('max-height: min(45vh, 360px)')
    expect(source).toContain('overflow-y: auto')
    expect(source).toContain('user-select: text')
    expect(source).toContain('notifications.slice().reverse()')
    expect(source).toContain('max-height: calc(100vh - var(--space-lg) - var(--space-lg))')
  })
})
