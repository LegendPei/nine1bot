import { describe, expect, test } from 'bun:test'
import {
  aggregateReviewFindings,
  buildGitLabDiffManifest,
  buildGitLabReviewContext,
  buildGitLabReviewIdempotencyKey,
  buildInitialGitLabReviewSubagentTasks,
  compileSubagentStageResults,
  defaultGitLabReviewSettings,
  GitLabApiError,
  parseSubagentStageResult,
  parseGitLabWebhookEvent,
  publishGitLabReviewResult,
  validateGitLabInlinePosition,
  validateGitLabWebhookToken,
  type GitLabRawChangesResponse,
  type ReviewFinding,
} from '../src'

describe('GitLab review foundation', () => {
  test('builds MR idempotency keys from head SHA and note id', () => {
    const base = {
      host: 'gitlab.example.com',
      projectId: 123,
      objectType: 'mr' as const,
      objectIid: 10,
      mode: 'webhook' as const,
      eventName: 'merge_request',
    }

    expect(buildGitLabReviewIdempotencyKey({ ...base, headSha: 'aaa' })).toBe(
      'gitlab:gitlab.example.com:123:mr:10:head_sha:aaa:auto:merge_request',
    )
    expect(buildGitLabReviewIdempotencyKey({ ...base, headSha: 'bbb', noteId: 55, mode: 'mention' })).toBe(
      'gitlab:gitlab.example.com:123:mr:10:head_sha:bbb:note:55',
    )
  })

  test('blocks GitLab overflow diffs', () => {
    const manifest = buildGitLabDiffManifest({
      overflow: true,
      changes: [{ old_path: 'src/large.ts', new_path: 'src/large.ts', diff: '', overflow: true }],
    })

    expect(manifest.blocked).toBe(true)
    expect(manifest.stats.truncated).toBe(true)
    expect(manifest.files).toEqual([])
  })

  test('filters noisy files before review context is built', () => {
    const manifest = buildGitLabDiffManifest({
      changes: [
        { old_path: 'src/app.ts', new_path: 'src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
        { old_path: 'package-lock.json', new_path: 'package-lock.json', diff: '@@ -1 +1 @@\n-a\n+b\n' },
        { old_path: 'public/logo.svg', new_path: 'public/logo.svg', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      ],
    })

    expect(manifest.blocked).toBe(false)
    expect(manifest.files.map((file) => file.newPath)).toEqual(['src/app.ts'])
    expect(manifest.skipped.map((file) => file.path)).toEqual(['package-lock.json', 'public/logo.svg'])
  })

  test('validates inline positions against changed diff lines', () => {
    const response: GitLabRawChangesResponse = {
      diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
      changes: [{
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        diff: '@@ -10,3 +10,4 @@\n context\n-old\n+new\n+another\n',
      }],
    }
    const manifest = buildGitLabDiffManifest(response)

    expect(validateGitLabInlinePosition({
      title: 'Changed line',
      body: 'Valid line',
      severity: 'major',
      file: 'src/app.ts',
      newLine: 11,
    }, manifest.files, manifest.diffRefs)).toMatchObject({ ok: true })

    expect(validateGitLabInlinePosition({
      title: 'Context line',
      body: 'Invalid line',
      severity: 'major',
      file: 'src/app.ts',
      newLine: 10,
    }, manifest.files, manifest.diffRefs)).toMatchObject({ ok: false })
  })

  test('groups deterministic finding duplicates before PM polishing', () => {
    const findings: ReviewFinding[] = [
      { title: 'Auth gap', body: 'QA body', severity: 'major', category: 'auth', file: 'src/auth.ts', newLine: 20, source: 'qa' },
      { title: 'Auth gap', body: 'Security body', severity: 'critical', category: 'auth', file: 'src/auth.ts', newLine: 20, source: 'security' },
    ]

    expect(aggregateReviewFindings(findings)).toMatchObject([
      {
        file: 'src/auth.ts',
        newLine: 20,
        severity: 'critical',
        sources: ['qa', 'security'],
        duplicates: [expect.objectContaining({ source: 'security' })],
      },
    ])
  })

  test('extracts subagent review JSON from task output and aggregates findings deterministically', () => {
    const specs = buildInitialGitLabReviewSubagentTasks()
    const compiled = compileSubagentStageResults({
      specs,
      outputs: [
        {
          taskId: 'qa-verification',
          text: [
            'QA notes',
            '```json',
            JSON.stringify({
              stage: 'verification',
              status: 'ok',
              summary: 'QA found auth gap',
              findings: [{
                title: 'Auth gap',
                body: 'QA evidence',
                severity: 'major',
                category: 'auth',
                file: 'src/auth.ts',
                newLine: 20,
              }],
              nextActions: ['add regression test'],
            }),
            '```',
          ].join('\n'),
        },
        {
          taskId: 'security-verification',
          text: JSON.stringify({
            stage: 'verification',
            status: 'ok',
            summary: 'Security found auth gap',
            findings: [{
              title: 'Auth gap',
              body: 'Security evidence',
              severity: 'critical',
              category: 'auth',
              file: 'src/auth.ts',
              newLine: 20,
            }],
          }),
        },
      ],
    })

    expect(compiled.status).toBe('ok')
    expect(compiled.findings).toMatchObject([{
      file: 'src/auth.ts',
      newLine: 20,
      severity: 'critical',
      sources: ['risk-qa', 'security-agent'],
      duplicates: [expect.objectContaining({ source: 'security-agent' })],
    }])
    expect(compiled.warnings).toEqual(['qa-verification: add regression test'])
  })

  test('applies subagent failure modes before PM wording', () => {
    const specs = buildInitialGitLabReviewSubagentTasks()
    const compiled = compileSubagentStageResults({
      specs,
      outputs: [
        { taskId: 'discovery-spec', timedOut: true },
        { taskId: 'qa-verification', error: 'model overloaded' },
        { taskId: 'technical-architecture', text: 'not json' },
      ],
    })

    expect(compiled.status).toBe('failed')
    expect(compiled.failedTasks).toMatchObject([
      { taskId: 'discovery-spec', failureMode: 'abort-run', reason: 'subagent-timeout' },
      { taskId: 'qa-verification', failureMode: 'ignore', reason: 'model overloaded' },
      { taskId: 'technical-architecture', failureMode: 'fallback', reason: 'missing-or-invalid-review-stage-result' },
    ])
    expect(compiled.warnings).toEqual([
      'discovery-spec aborted the review run: subagent-timeout',
      'qa-verification was ignored after failure: model overloaded',
      'technical-architecture used fallback after failure: missing-or-invalid-review-stage-result',
    ])
  })

  test('parses PM tagged review result from subagent style output', () => {
    const result = parseSubagentStageResult([
      '```json',
      'GITLAB_REVIEW_RESULT:',
      JSON.stringify({
        stage: 'closed',
        status: 'ok',
        summary: 'done',
        findings: [],
      }),
      '```',
      '<task_metadata>',
      'session_id: session_123',
      '</task_metadata>',
    ].join('\n'))

    expect(result).toMatchObject({ stage: 'closed', status: 'ok', summary: 'done' })
  })

  test('keeps GitLab code review disabled by default', () => {
    expect(defaultGitLabReviewSettings.enabled).toBe(false)
    expect(defaultGitLabReviewSettings.executionMode).toBe('dry-run')
  })

  test('validates GitLab webhook tokens without accepting missing secrets', () => {
    expect(validateGitLabWebhookToken({ expectedSecret: 'secret', receivedToken: 'secret' })).toEqual({ ok: true })
    expect(validateGitLabWebhookToken({ expectedSecret: 'secret', receivedToken: 'wrong' })).toMatchObject({ ok: false })
    expect(validateGitLabWebhookToken({ receivedToken: 'secret' })).toMatchObject({ ok: false, reason: 'missing-webhook-secret' })
  })

  test('parses mention note webhooks into review triggers', () => {
    const result = parseGitLabWebhookEvent({
      object_kind: 'note',
      project: {
        id: 123,
        path_with_namespace: 'nine1/nine1bot',
        web_url: 'https://gitlab.example.com/nine1/nine1bot',
      },
      object_attributes: {
        id: 777,
        note: '@Nine1bot review this',
      },
      merge_request: {
        iid: 10,
        last_commit: { id: 'abc123' },
      },
    }, {
      ...defaultGitLabReviewSettings,
      enabled: true,
      allowedHosts: ['gitlab.example.com'],
      allowedProjectIds: [123],
    })

    expect(result).toMatchObject({
      ok: true,
      trigger: {
        objectType: 'mr',
        objectIid: 10,
        headSha: 'abc123',
        noteId: 777,
        mode: 'mention',
      },
    })
  })

  test('parses commit mention note webhooks into review triggers', () => {
    const result = parseGitLabWebhookEvent({
      object_kind: 'note',
      project: {
        id: 123,
        path_with_namespace: 'nine1/nine1bot',
        web_url: 'https://gitlab.example.com/nine1/nine1bot',
      },
      object_attributes: {
        id: 778,
        note: '@Nine1bot review commit',
      },
      commit: {
        id: 'commit123',
      },
    }, {
      ...defaultGitLabReviewSettings,
      enabled: true,
      allowedHosts: ['gitlab.example.com'],
      allowedProjectIds: [123],
    })

    expect(result).toMatchObject({
      ok: true,
      trigger: {
        objectType: 'commit',
        commitSha: 'commit123',
        noteId: 778,
        mode: 'mention',
      },
    })
  })

  test('builds review context blocks from trigger and changes', () => {
    const context = buildGitLabReviewContext({
      trigger: {
        host: 'gitlab.example.com',
        projectId: 123,
        objectType: 'mr',
        objectIid: 10,
        headSha: 'abc123',
        mode: 'webhook',
      },
      changes: {
        changes: [{ old_path: 'src/app.ts', new_path: 'src/app.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' }],
      },
    })

    expect(context.idempotencyKey).toBe('gitlab:gitlab.example.com:123:mr:10:head_sha:abc123:auto:webhook')
    expect(context.contextBlocks.map((block) => block.source)).toEqual([
      'platform.gitlab.review.trigger',
      'platform.gitlab.review.diff',
    ])
  })

  test('publishes valid inline comments and one summary note', async () => {
    const manifest = buildGitLabDiffManifest({
      diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'head' },
      changes: [{
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
      }],
    })
    const calls: string[] = []
    const result = await publishGitLabReviewResult({
      client: {
        async createDiscussion() {
          calls.push('discussion')
          return {}
        },
        async createNote() {
          calls.push('note')
          return {}
        },
      },
      projectId: 123,
      objectType: 'mr',
      objectId: 10,
      manifest,
      summary: 'Review complete.',
      inlineComments: true,
      findings: [{
        title: 'Changed line',
        body: 'Inline body',
        severity: 'major',
        file: 'src/app.ts',
        newLine: 2,
      }],
    })

    expect(result).toMatchObject({ summaryPosted: true, inlinePosted: 1, fallbackPosted: 0 })
    expect(calls).toEqual(['discussion', 'note'])
  })

  test('falls back to summary note when inline line is outside diff hunks', async () => {
    const manifest = buildGitLabDiffManifest({
      changes: [{
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
      }],
    })
    const notes: string[] = []
    const result = await publishGitLabReviewResult({
      client: {
        async createDiscussion() {
          throw new Error('should not post inline')
        },
        async createNote(input) {
          notes.push(input.body)
          return {}
        },
      },
      projectId: 123,
      objectType: 'mr',
      objectId: 10,
      manifest,
      summary: 'Review complete.',
      inlineComments: true,
      findings: [{
        title: 'Context line',
        body: 'Fallback body',
        severity: 'major',
        file: 'src/app.ts',
        newLine: 1,
      }],
    })

    expect(result.fallbackPosted).toBe(1)
    expect(notes[0]).toContain('Inline Fallbacks')
  })

  test('falls back to summary note when GitLab rejects inline position', async () => {
    const manifest = buildGitLabDiffManifest({
      changes: [{
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
      }],
    })
    const result = await publishGitLabReviewResult({
      client: {
        async createDiscussion() {
          throw new GitLabApiError(400, 'Bad Request')
        },
        async createNote() {
          return {}
        },
      },
      projectId: 123,
      objectType: 'mr',
      objectId: 10,
      manifest,
      summary: 'Review complete.',
      inlineComments: true,
      findings: [{
        title: 'Changed line',
        body: 'Inline body',
        severity: 'major',
        file: 'src/app.ts',
        newLine: 2,
      }],
    })

    expect(result).toMatchObject({ inlinePosted: 0, fallbackPosted: 1 })
    expect(result.warnings[0]).toContain('GitLab API returned 400')
  })

  test('publishes commit reviews as summary comments without inline discussions', async () => {
    const manifest = buildGitLabDiffManifest({
      changes: [{
        old_path: 'src/app.ts',
        new_path: 'src/app.ts',
        diff: '@@ -1,2 +1,3 @@\n context\n+changed\n',
      }],
    })
    const calls: string[] = []
    const result = await publishGitLabReviewResult({
      client: {
        async createDiscussion() {
          calls.push('discussion')
          return {}
        },
        async createNote() {
          calls.push('note')
          return {}
        },
      },
      projectId: 123,
      objectType: 'commit',
      objectId: 'commit123',
      manifest,
      summary: 'Commit review complete.',
      inlineComments: true,
      findings: [{
        title: 'Changed line',
        body: 'Commit finding body',
        severity: 'major',
        file: 'src/app.ts',
        newLine: 2,
      }],
    })

    expect(calls).toEqual(['note'])
    expect(result).toMatchObject({
      summaryPosted: true,
      inlinePosted: 0,
      fallbackPosted: 0,
    })
    expect(result.warnings[0]).toContain('Inline comments are skipped for commit review runs')
  })
})
