import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

describe('GitLab project profile host identity', () => {
  test('preserves stored hosts and derives hosts for newly selected projects', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'components', 'PlatformManager.vue'), 'utf8')

    expect(source).toContain('host: optionalProfileText(record.host)')
    expect(source).toContain('host,')
    expect(source).toContain('return new URL(webUrl).host.toLowerCase()')
    expect(source).toContain('profile.host === host && String(profile.projectId) === String(project.id)')
    expect(source).toContain('id: gitLabProjectProfileId(host, project.id)')
  })

  test('binds GitLab review profiles to existing Nine1Bot projects', async () => {
    const manager = await readFile(join(import.meta.dir, '..', 'src', 'components', 'PlatformManager.vue'), 'utf8')
    const settings = await readFile(join(import.meta.dir, '..', 'src', 'components', 'SettingsPanel.vue'), 'utf8')
    const app = await readFile(join(import.meta.dir, '..', 'src', 'App.vue'), 'utf8')

    expect(manager).toContain('projects: Nine1BotProjectOption[]')
    expect(manager).toContain('nine1botProjectID: string')
    expect(manager).toContain('profile.nine1botProjectID')
    expect(manager).toContain('Nine1Bot 项目')
    expect(settings).toContain('projects: Nine1BotProjectOption[]')
    expect(settings).toContain(':projects="projects"')
    expect(app).toMatch(/<SettingsPanel[\s\S]*?:projects="projects"[\s\S]*?@close="closeSettings"/)
  })

  test('edits every supported review overlay and CI limit without exposing raw JSON', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'components', 'PlatformManager.vue'), 'utf8')

    expect(source).toContain('reviewContextMarkdown?: string')
    expect(source).toContain('optionalProfileText(record.reviewContextMarkdown) ?? optionalProfileText(record.contextMarkdown)')
    expect(source).toContain('profile.reviewContextMarkdown')
    expect(source).not.toContain('profile.contextMarkdown')
    expect(source).toContain('profile.includePathPrefixes')
    expect(source).toContain('profile.excludePathPatterns')
    expect(source).toContain('profile.maxContextBytes')
    expect(source).toContain('profile.maxFiles')
    expect(source).toContain('profile.ci.maxJobLogBytes')
    expect(source).toContain('jsonErrors[gitLabProjectProfilesFieldKey]')
  })
})
