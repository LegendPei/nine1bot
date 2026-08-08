import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('GitLab project profile host identity', () => {
  test('preserves stored hosts and derives hosts for newly selected projects', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'components', 'PlatformManager.vue'), 'utf8')

    expect(source).toContain('host: optionalProfileText(record.host)')
    expect(source).toContain('host: gitLabProjectHost(project.webUrl)')
    expect(source).toContain('return new URL(webUrl).host')
  })
})
