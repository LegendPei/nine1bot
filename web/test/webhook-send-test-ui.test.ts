import { describe, expect, it } from 'bun:test'

describe('webhook send test controls', () => {
  it('keeps Send test available without a one-time revealed secret', async () => {
    const source = await Bun.file(new URL('../src/components/WebhooksPage.vue', import.meta.url)).text()
    const button = source.match(/<button class="btn" @click="sendTest" :disabled="([^"]+)">/)

    expect(button?.[1]).toBe('isSaving || isSendingTest')
    expect(source).not.toContain('Send test requires the one-time full URL')
  })
})
