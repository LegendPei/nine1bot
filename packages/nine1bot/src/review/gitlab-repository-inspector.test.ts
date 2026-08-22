import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  gitLabReviewRepositoryGitEnvironment,
  gitLabReviewRepositoryDirectoryFingerprint,
  inspectGitLabRepositoryForSession,
} from './gitlab-repository-inspector'
import { ReviewRunStore } from './run-store'

const tempDirs: string[] = []

describe('GitLab review repository inspector', () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nine1bot-repository-inspector-store-'))
    tempDirs.push(dir)
    ReviewRunStore.setPathForTesting(join(dir, 'review-runs.json'))
    ReviewRunStore.clearForTesting()
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test('removes inherited Git routing variables from fixed-command subprocesses', () => {
    const environment = gitLabReviewRepositoryGitEnvironment({
      PATH: 'git-path',
      SystemRoot: 'C:/Windows',
      HOME: 'home-path',
      HTTPS_PROXY: 'http://proxy-with-credentials.example.com',
      NINE1BOT_PRIVATE_TOKEN: 'must-not-reach-git',
      GIT_DIR: 'C:/foreign/.git',
      GIT_WORK_TREE: 'C:/foreign',
      GIT_OBJECT_DIRECTORY: 'C:/foreign/objects',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'alias.grep',
      GIT_CONFIG_VALUE_0: '!malicious-command',
    })

    expect(environment).toEqual({
      PATH: 'git-path',
      SystemRoot: 'C:/Windows',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ALLOW_PROTOCOL: '',
    })
  })

  test('reads and searches the frozen review head instead of the current checkout', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, 'src', 'app.ts'), 'frozen value\nneedle at frozen head\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'frozen head')
    const frozenHead = await git(repository, 'rev-parse', 'HEAD')

    await writeFile(join(repository, 'src', 'app.ts'), 'current value\nneedle removed\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'advance checkout')
    createReviewRun('session-frozen', frozenHead, repository)

    const read = await inspectGitLabRepositoryForSession({
      sessionId: 'session-frozen',
      directory: repository,
      request: { action: 'read_file', path: 'src/app.ts' },
    })
    const search = await inspectGitLabRepositoryForSession({
      sessionId: 'session-frozen',
      directory: repository,
      request: { action: 'search_text', query: 'needle at frozen head', pathPrefix: 'src' },
    })
    const literalPathspec = await inspectGitLabRepositoryForSession({
      sessionId: 'session-frozen',
      directory: repository,
      request: { action: 'search_text', query: 'needle at frozen head', pathPrefix: ':(top)src' },
    })

    expect(read).toMatchObject({
      ok: true,
      action: 'read_file',
      headSha: frozenHead,
      path: 'src/app.ts',
      content: 'frozen value\nneedle at frozen head\n',
      startLine: 1,
      endLine: 2,
      truncated: false,
    })
    expect(read).not.toMatchObject({ content: expect.stringContaining('current value') })
    expect(search).toMatchObject({
      ok: true,
      action: 'search_text',
      headSha: frozenHead,
      matches: [{ path: 'src/app.ts', line: 2, text: 'needle at frozen head' }],
      truncated: false,
    })
    expect(literalPathspec).toMatchObject({
      ok: true,
      action: 'search_text',
      matches: [],
    })
  })

  test('rejects directory and path escapes before returning repository data', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, 'src', 'app.ts'), 'review source\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'review head')
    const head = await git(repository, 'rev-parse', 'HEAD')
    createReviewRun('session-bound', head, repository)

    const foreignDirectory = await createRepository()
    const foreign = await inspectGitLabRepositoryForSession({
      sessionId: 'session-bound',
      directory: foreignDirectory,
      request: { action: 'read_file', path: 'src/app.ts' },
    })
    const traversal = await inspectGitLabRepositoryForSession({
      sessionId: 'session-bound',
      directory: repository,
      request: { action: 'read_file', path: '../outside-secret.txt' },
    })
    const gitMetadata = await inspectGitLabRepositoryForSession({
      sessionId: 'session-bound',
      directory: repository,
      request: { action: 'read_file', path: '.git/config' },
    })

    expect(foreign).toEqual({
      ok: false,
      action: 'read_file',
      diagnostic: 'repository_directory_binding_mismatch',
    })
    expect(traversal).toEqual({
      ok: false,
      action: 'read_file',
      diagnostic: 'repository_path_invalid',
    })
    expect(gitMetadata).toEqual({
      ok: false,
      action: 'read_file',
      diagnostic: 'repository_path_invalid',
    })
  })

  test('reads a symlink as a frozen Git blob without following it on disk', async () => {
    const repository = await createRepository()
    const outsideSecret = join(repository, '..', 'outside-secret.txt')
    await writeFile(outsideSecret, 'must never be returned')
    await writeFile(join(repository, 'link-target.txt'), '../outside-secret.txt')
    const linkBlob = await git(repository, 'hash-object', '-w', 'link-target.txt')
    await git(repository, 'update-index', '--add', '--cacheinfo', '120000', linkBlob, 'escape-link')
    await git(repository, 'commit', '-qm', 'add frozen symlink blob')
    const head = await git(repository, 'rev-parse', 'HEAD')
    createReviewRun('session-link', head, repository)

    const result = await inspectGitLabRepositoryForSession({
      sessionId: 'session-link',
      directory: repository,
      request: { action: 'read_file', path: 'escape-link' },
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'read_file',
      content: '../outside-secret.txt',
    })
    expect(JSON.stringify(result)).not.toContain('must never be returned')
    await rm(outsideSecret, { force: true })
  })

  test('ignores local replacement refs when reading the frozen review head', async () => {
    const repository = await createRepository()
    await writeFile(join(repository, 'src', 'app.ts'), 'original frozen content\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'original frozen head')
    const frozenHead = await git(repository, 'rev-parse', 'HEAD')

    await writeFile(join(repository, 'src', 'app.ts'), 'replacement content\n')
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'replacement commit')
    const replacementHead = await git(repository, 'rev-parse', 'HEAD')
    await git(repository, 'replace', frozenHead, replacementHead)
    createReviewRun('session-replace', frozenHead, repository)

    const result = await inspectGitLabRepositoryForSession({
      sessionId: 'session-replace',
      directory: repository,
      request: { action: 'read_file', path: 'src/app.ts' },
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'read_file',
      headSha: frozenHead,
      content: 'original frozen content\n',
    })
  })

  test('bounds per-call output and the total number of repository queries', async () => {
    const repository = await createRepository()
    await writeFile(
      join(repository, 'src', 'large.ts'),
      Array.from({ length: 400 }, (_, index) => `${index}: ${'x'.repeat(120)}`).join('\n'),
    )
    await git(repository, 'add', '.')
    await git(repository, 'commit', '-qm', 'large review file')
    const head = await git(repository, 'rev-parse', 'HEAD')
    const run = createReviewRun('session-budget', head, repository)

    const first = await inspectGitLabRepositoryForSession({
      sessionId: 'session-budget',
      directory: repository,
      request: { action: 'read_file', path: 'src/large.ts', maxLines: 200 },
    })
    expect(first).toMatchObject({ ok: true, action: 'read_file', truncated: true })
    if (!first.ok || first.action !== 'read_file') throw new Error('expected bounded file output')
    expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(20 * 1024)

    const repositoryBudget = ReviewRunStore.get(run.id)?.repository
    if (!repositoryBudget) throw new Error('expected repository budget state')
    ReviewRunStore.update(run.id, {
      repository: { ...repositoryBudget, queryCount: 11 },
    })
    const finalAllowed = await inspectGitLabRepositoryForSession({
      sessionId: 'session-budget',
      directory: repository,
      request: { action: 'search_text', query: 'not-present' },
    })
    expect(finalAllowed.ok).toBe(true)
    const exhausted = await inspectGitLabRepositoryForSession({
      sessionId: 'session-budget',
      directory: repository,
      request: { action: 'read_file', path: 'src/large.ts' },
    })

    expect(exhausted).toEqual({
      ok: false,
      action: 'read_file',
      diagnostic: 'repository_query_limit_reached',
    })
    expect(ReviewRunStore.get(run.id)?.repository).toMatchObject({ queryCount: 12 })
  })
})

async function createRepository() {
  const repository = await mkdtemp(join(tmpdir(), 'nine1bot-review-repository-'))
  tempDirs.push(repository)
  await git(repository, 'init', '-q')
  await git(repository, 'config', 'user.name', 'Nine1Bot Test')
  await git(repository, 'config', 'user.email', 'nine1bot@example.com')
  await git(repository, 'config', 'core.autocrlf', 'false')
  await mkdir(join(repository, 'src'), { recursive: true })
  return repository
}

function createReviewRun(sessionId: string, headSha: string, directory: string) {
  return ReviewRunStore.create({
    platform: 'gitlab',
    status: 'running',
    sessionId,
    trigger: {
      host: 'gitlab.example.com',
      projectId: 3,
      projectPath: 'root/uftest',
      objectType: 'mr',
      objectIid: 10,
      headSha,
      mode: 'webhook',
    },
    project: {
      id: 'uftest',
      host: 'gitlab.example.com',
      projectId: 3,
      nine1botProjectID: 'project-uf',
      pathWithNamespace: 'root/uftest',
      enabled: true,
      reviewFocus: [],
      includePathPrefixes: [],
      excludePathPatterns: [],
      ci: { maxJobLogs: 2, maxJobLogBytes: 80 },
      source: 'configured',
      matchedAt: 1,
    },
    repository: {
      directoryFingerprint: gitLabReviewRepositoryDirectoryFingerprint(directory),
      queryCount: 0,
      readCount: 0,
      searchCount: 0,
      outputBytes: 0,
    },
  })
}

async function git(directory: string, ...args: string[]) {
  const process = Bun.spawn(['git', ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`)
  return stdout.trim()
}
