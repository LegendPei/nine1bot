import { describe, expect, test } from 'bun:test'
import {
  createGitLabProjectProfile,
  parseGitLabProjectProfiles,
  serializeGitLabProjectProfiles,
} from '../src/lib/gitlab-project-profiles'

describe('GitLab project profiles', () => {
  test('round-trips every canonical review overlay and CI limit', () => {
    const original = createGitLabProjectProfile({
      id: 3,
      pathWithNamespace: 'root/uftest',
      webUrl: 'https://gitlab.example.com/root/uftest',
    }, 'https://gitlab.example.com')
    const configured = {
      ...original,
      nine1botProjectID: 'project-uf',
      reviewContextMarkdown: 'UF review overlay',
      reviewFocus: ['auth'],
      includePathPrefixes: ['src/'],
      excludePathPatterns: ['**/*.generated.ts'],
      maxContextBytes: 120_000,
      maxFiles: 40,
      ci: { maxJobLogs: 4, maxJobLogBytes: 12_000 },
    }

    expect(parseGitLabProjectProfiles(serializeGitLabProjectProfiles([configured])))
      .toEqual([configured])
  })

  test('migrates legacy context and failed-job fields to canonical output', () => {
    const profiles = parseGitLabProjectProfiles(JSON.stringify([{
      id: 'legacy',
      host: 'https://GITLAB.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      contextMarkdown: 'Legacy overlay',
      reviewFocus: [' auth ', '', 'security'],
      ci: {
        enabled: false,
        includeFailedJobLogs: false,
        maxFailedJobs: 5,
        maxJobLogBytes: 9_000,
      },
    }]))

    expect(profiles).toEqual([expect.objectContaining({
      id: 'legacy',
      host: 'gitlab.example.com',
      reviewContextMarkdown: 'Legacy overlay',
      reviewFocus: ['auth', 'security'],
      ci: { maxJobLogs: 5, maxJobLogBytes: 9_000 },
    })])
    const canonical = serializeGitLabProjectProfiles(profiles)
    expect(canonical).not.toContain('contextMarkdown')
    expect(canonical).not.toContain('maxFailedJobs')
    expect(canonical).not.toContain('includeFailedJobLogs')
    expect(canonical).not.toContain('"enabled": false')
  })

  test('deduplicates normalized host and project identities while preserving custom ports', () => {
    const profiles = parseGitLabProjectProfiles(JSON.stringify([
      {
        id: 'first',
        host: 'gitlab.example.com:8443',
        projectId: 3,
        nine1botProjectID: 'project-uf',
      },
      {
        id: 'duplicate',
        host: 'https://GITLAB.EXAMPLE.COM:8443/root',
        projectId: '3',
        nine1botProjectID: 'project-other',
      },
    ]))

    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      id: 'first',
      host: 'gitlab.example.com:8443',
      projectId: 3,
    })

    expect(createGitLabProjectProfile({
      id: 8,
      pathWithNamespace: 'root/custom',
    }, 'http://gitlab.example.com:9443/gitlab')).toMatchObject({
      id: 'project-gitlab.example.com-9443-8',
      host: 'gitlab.example.com:9443',
      projectId: 8,
      ci: { maxJobLogs: 3, maxJobLogBytes: 8_000 },
    })
  })

  test('uses the selected project URL before the configured base URL', () => {
    const profile = createGitLabProjectProfile({
      id: 9,
      pathWithNamespace: 'team/repo',
      webUrl: 'https://project-host.example.com:7443/team/repo',
    }, 'https://configured-host.example.com')

    expect(profile.host).toBe('project-host.example.com:7443')
    expect(parseGitLabProjectProfiles('not-json')).toEqual([])
  })
})
