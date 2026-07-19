import { describe, expect, it } from 'bun:test'

describe('webhook send test controls', () => {
  it('keeps Send test available without a one-time revealed secret', async () => {
    const source = await Bun.file(new URL('../src/components/WebhooksPage.vue', import.meta.url)).text()
    const button = source.match(/<button class="btn" @click="sendTest" :disabled="([^"]+)">/)

    expect(button?.[1]).toBe('isSaving || isSendingTest')
    expect(source).not.toContain('Send test requires the one-time full URL')
  })

  it('renders a ten-item server-backed pager for run records', async () => {
    const source = await Bun.file(new URL('../src/components/WebhooksPage.vue', import.meta.url)).text()

    expect(source).toContain('const RUN_PAGE_SIZE = 10')
    expect(source).toContain('v-for="run in runPageItems"')
    expect(source).toContain('@click="previousRunPage"')
    expect(source).toContain('@click="nextRunPage"')
    expect(source).toContain('第 {{ runPage }} 页')
    expect(source).not.toContain('v-for="run in selectedRuns"')
  })
})
