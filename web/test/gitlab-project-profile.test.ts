import { describe, expect, test } from 'bun:test'
import {
  createGitLabProjectProfile,
  parseGitLabProjectProfiles,
  serializeGitLabProjectProfiles,
  validateGitLabProjectBindings,
} from '../src/lib/gitlab-project-profiles'
import {
  parseGitLabProjectProfileDocument,
  serializeGitLabProjectProfileDocument,
  updateGitLabProjectProfileDocument,
  validateGitLabProjectProfileDocument,
} from '../src/lib/gitlab-project-profile-document'

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

  test('rejects stale project bindings even when the project list is empty', () => {
    const profileWithBinding = {
      ...createGitLabProjectProfile({ id: 3, pathWithNamespace: 'root/uftest' }, 'https://gitlab.example.com'),
      nine1botProjectID: 'project-uf',
    }
    const matchingProject = { id: 'project-uf' }

    expect(validateGitLabProjectBindings([profileWithBinding], [])).toContain('不存在')
    expect(validateGitLabProjectBindings([profileWithBinding], [matchingProject])).toBeUndefined()
  })

  test('preserves malformed and duplicate entries while editing a valid profile document entry', () => {
    const document = parseGitLabProjectProfileDocument(JSON.stringify([
      { id: 'first', host: 'gitlab.example.com', projectId: 1, nine1botProjectID: 'project-one' },
      { id: 'first', host: 'other.example.com', projectId: 2, nine1botProjectID: 'project-two' },
      { id: 'same-identity', host: 'https://GITLAB.example.com', projectId: '1', nine1botProjectID: 'project-three' },
      { malformed: true },
      {
        id: 'editable',
        host: 'gitlab.example.com',
        projectId: 5,
        nine1botProjectID: 'project-five',
        extensionField: { preserve: true },
        ci: { maxFailedJobs: 4, maxJobLogBytes: 9_000 },
      },
    ]))

    expect(document.entries).toHaveLength(5)
    expect(document.editable).toHaveLength(4)
    const editable = document.editable.find((entry) => entry.index === 4)
    expect(editable).toBeDefined()
    const updated = updateGitLabProjectProfileDocument(document, 4, {
      ...editable!.profile,
      displayName: 'Edited profile',
    })

    expect(updated.entries).toHaveLength(5)
    expect(updated.entries[3]).toEqual({ malformed: true })
    expect(updated.entries[4]).toMatchObject({
      displayName: 'Edited profile',
      extensionField: { preserve: true },
      ci: { maxFailedJobs: 4, maxJobLogBytes: 9_000 },
    })
    expect(JSON.stringify(updated.entries[4])).not.toContain('maxJobLogs')
    expect(validateGitLabProjectProfileDocument(updated).map((item) => item.code)).toEqual(expect.arrayContaining([
      'profile_id_duplicate',
      'profile_identity_duplicate',
      'profile_id_missing',
    ]))
    expect(serializeGitLabProjectProfileDocument(updated)).toMatchObject({
      ok: false,
      diagnostics: expect.any(Array),
    })
  })

  test('round-trips a valid profile document and migrates legacy fields only after validation', () => {
    const document = parseGitLabProjectProfileDocument(JSON.stringify([{
      id: 'legacy',
      host: 'https://GITLAB.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      contextMarkdown: 'Legacy overlay',
      extensionField: 'preserved',
      ci: {
        maxFailedJobs: 5,
        maxJobLogBytes: 9_000,
        extensionLimit: 12,
      },
    }]))
    const result = serializeGitLabProjectProfileDocument(document)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected valid profile document')
    const reloaded = JSON.parse(result.value)
    expect(reloaded).toEqual([expect.objectContaining({
      id: 'legacy',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      reviewContextMarkdown: 'Legacy overlay',
      extensionField: 'preserved',
      ci: {
        maxJobLogs: 5,
        maxJobLogBytes: 9_000,
        extensionLimit: 12,
      },
    })])
    expect(result.value).not.toContain('contextMarkdown')
    expect(result.value).not.toContain('maxFailedJobs')
    expect(parseGitLabProjectProfileDocument(result.value).entries).toEqual(reloaded)
  })
})
