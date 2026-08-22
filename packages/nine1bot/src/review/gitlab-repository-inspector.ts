import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import {
  ReviewRunStore,
  type ReviewRunIdentity,
  type ReviewRunRecord,
} from './run-store'

export type GitLabRepositorySessionRequest =
  | {
      action: 'read_file'
      path: string
      startLine?: number
      maxLines?: number
    }
  | {
      action: 'search_text'
      query: string
      pathPrefix?: string
    }

type GitLabRepositoryMatch = {
  path: string
  line: number
  text: string
}

export type GitLabRepositoryToolOutput =
  | {
      ok: true
      action: 'read_file'
      headSha: string
      path: string
      content: string
      startLine: number
      endLine: number
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: true
      action: 'search_text'
      headSha: string
      query: string
      pathPrefix?: string
      matches: GitLabRepositoryMatch[]
      bytes: number
      truncated: boolean
      diagnostics: string[]
    }
  | {
      ok: false
      action: GitLabRepositorySessionRequest['action']
      diagnostic: string
    }

const MAX_REPOSITORY_QUERIES = 12
const MAX_REPOSITORY_OUTPUT_BYTES = 128 * 1024
const MAX_TOOL_CONTENT_BYTES = 20 * 1024
const MAX_FILE_BLOB_BYTES = 256 * 1024
const MAX_READ_LINES = 200
const DEFAULT_READ_LINES = 120
const MAX_SEARCH_MATCHES = 50
const MAX_GIT_PATH_BYTES = 1_024
const MAX_SEARCH_QUERY_BYTES = 256
const GIT_COMMAND_TIMEOUT_MS = 5_000
const GIT_SUBPROCESS_ENVIRONMENT_KEYS = new Set([
  'path',
  'pathext',
  'systemroot',
  'windir',
  'comspec',
  'temp',
  'tmp',
  'tmpdir',
])

export function gitLabReviewRepositoryDirectoryFingerprint(directory: string) {
  const canonical = realpathSync.native(resolve(directory))
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return createHash('sha256').update(normalized).digest('hex')
}

export function gitLabReviewRepositoryGitEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && GIT_SUBPROCESS_ENVIRONMENT_KEYS.has(key.toLowerCase())) {
      sanitized[key] = value
    }
  }
  return {
    ...sanitized,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ALLOW_PROTOCOL: '',
  }
}

export async function inspectGitLabRepositoryForSession(input: {
  sessionId: string
  directory: string
  request: GitLabRepositorySessionRequest
  signal?: AbortSignal
}): Promise<GitLabRepositoryToolOutput> {
  const action = input.request.action
  const run = ReviewRunStore.findBySessionId(input.sessionId)
  if (!run) return failure(action, 'gitlab_review_session_not_bound')
  const identity: ReviewRunIdentity = {
    runId: run.id,
    sessionId: input.sessionId,
    generation: run.generation,
  }
  const lifecycleFailure = repositoryLifecycleFailure(identity, input.signal)
  if (lifecycleFailure) return failure(action, lifecycleFailure)

  const headSha = reviewHeadSha(run)
  if (!headSha) return failure(action, 'gitlab_review_head_identity_missing')
  if (!projectSnapshotMatches(run)) {
    return failure(action, 'gitlab_review_project_snapshot_missing')
  }
  const binding = run.repository?.directoryFingerprint
  if (!binding || !/^[a-f0-9]{64}$/.test(binding)) {
    return failure(action, 'repository_directory_not_bound')
  }

  let directoryFingerprint: string
  try {
    directoryFingerprint = gitLabReviewRepositoryDirectoryFingerprint(input.directory)
  } catch {
    return failure(action, 'repository_directory_unavailable')
  }
  if (directoryFingerprint !== binding) {
    return failure(action, 'repository_directory_binding_mismatch')
  }

  const validatedRequest = validateRequest(input.request)
  if (!validatedRequest.ok) return failure(action, validatedRequest.diagnostic)

  const reservation = reserveRepositoryQuery(identity, action)
  if (!reservation.ok) return failure(action, reservation.diagnostic)

  const repositoryFailure = await verifyBoundRepository({
    directory: input.directory,
    directoryFingerprint,
    headSha,
    signal: input.signal,
  })
  if (repositoryFailure) return failure(action, repositoryFailure)

  if (validatedRequest.request.action === 'read_file') {
    return await readFrozenFile({
      identity,
      directory: input.directory,
      headSha,
      request: validatedRequest.request,
      maxOutputBytes: reservation.maxOutputBytes,
      signal: input.signal,
    })
  }
  return await searchFrozenRepository({
    identity,
    directory: input.directory,
    headSha,
    request: validatedRequest.request,
    maxOutputBytes: reservation.maxOutputBytes,
    signal: input.signal,
  })
}

async function verifyBoundRepository(input: {
  directory: string
  directoryFingerprint: string
  headSha: string
  signal?: AbortSignal
}) {
  const root = await runGit({
    directory: input.directory,
    args: ['rev-parse', '--show-toplevel'],
    maxOutputBytes: 4_096,
    signal: input.signal,
  })
  const rootFailure = gitCommandFailure(root)
  if (rootFailure) return rootFailure
  const rootPath = decodeUtf8(root.stdout)?.trim()
  if (!rootPath) return 'repository_git_root_unavailable'
  try {
    if (gitLabReviewRepositoryDirectoryFingerprint(rootPath) !== input.directoryFingerprint) {
      return 'repository_git_root_mismatch'
    }
  } catch {
    return 'repository_git_root_unavailable'
  }

  const commit = await runGit({
    directory: input.directory,
    args: ['cat-file', '-e', `${input.headSha}^{commit}`],
    maxOutputBytes: 1,
    signal: input.signal,
  })
  const commitFailure = gitCommandFailure(commit)
  if (commitFailure === 'repository_git_command_failed') return 'repository_head_unavailable'
  return commitFailure
}

async function readFrozenFile(input: {
  identity: ReviewRunIdentity
  directory: string
  headSha: string
  request: Extract<GitLabRepositorySessionRequest, { action: 'read_file' }>
  maxOutputBytes: number
  signal?: AbortSignal
}): Promise<GitLabRepositoryToolOutput> {
  const object = `${input.headSha}:${input.request.path}`
  const type = await runGit({
    directory: input.directory,
    args: ['cat-file', '-t', object],
    maxOutputBytes: 64,
    signal: input.signal,
  })
  const typeFailure = gitCommandFailure(type)
  if (typeFailure === 'repository_git_command_failed') return failure('read_file', 'repository_file_not_found')
  if (typeFailure) return failure('read_file', typeFailure)
  if (decodeUtf8(type.stdout)?.trim() !== 'blob') return failure('read_file', 'repository_path_not_file')

  const sizeResult = await runGit({
    directory: input.directory,
    args: ['cat-file', '-s', object],
    maxOutputBytes: 64,
    signal: input.signal,
  })
  const sizeFailure = gitCommandFailure(sizeResult)
  if (sizeFailure) return failure('read_file', sizeFailure)
  const size = Number.parseInt(decodeUtf8(sizeResult.stdout)?.trim() ?? '', 10)
  if (!Number.isSafeInteger(size) || size < 0) return failure('read_file', 'repository_file_size_invalid')
  if (size > MAX_FILE_BLOB_BYTES) return failure('read_file', 'repository_file_too_large')

  const blob = await runGit({
    directory: input.directory,
    args: ['cat-file', 'blob', object],
    maxOutputBytes: size + 1,
    signal: input.signal,
  })
  const blobFailure = gitCommandFailure(blob)
  if (blobFailure) return failure('read_file', blobFailure)
  const source = decodeUtf8(blob.stdout)
  if (source === undefined || source.includes('\0')) return failure('read_file', 'repository_file_binary')

  const startLine = input.request.startLine ?? 1
  const maxLines = input.request.maxLines ?? DEFAULT_READ_LINES
  const lines = logicalLines(source)
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines)
  let content = selected.join('\n')
  const selectedThroughEnd = startLine - 1 + selected.length >= lines.length
  if (source.endsWith('\n') && selected.length > 0 && selectedThroughEnd) content += '\n'
  const bounded = boundedUtf8Prefix(content, input.maxOutputBytes)
  content = bounded.value
  const returnedLineCount = content.length === 0
    ? 0
    : content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
  const endLine = returnedLineCount > 0 ? startLine + returnedLineCount - 1 : startLine - 1
  const truncated = startLine > 1
    || !selectedThroughEnd
    || bounded.truncated
  const bytes = utf8Bytes(content)
  const persistenceFailure = recordRepositoryOutput(input.identity, bytes)
  if (persistenceFailure) return failure('read_file', persistenceFailure)

  return {
    ok: true,
    action: 'read_file',
    headSha: input.headSha,
    path: input.request.path,
    content,
    startLine,
    endLine,
    bytes,
    truncated,
    diagnostics: truncated ? ['repository_file_output_truncated'] : [],
  }
}

async function searchFrozenRepository(input: {
  identity: ReviewRunIdentity
  directory: string
  headSha: string
  request: Extract<GitLabRepositorySessionRequest, { action: 'search_text' }>
  maxOutputBytes: number
  signal?: AbortSignal
}): Promise<GitLabRepositoryToolOutput> {
  const args = [
    '--literal-pathspecs',
    'grep',
    '--full-name',
    '-n',
    '-z',
    '-I',
    '-F',
    '-e',
    input.request.query,
    input.headSha,
    '--',
    ...(input.request.pathPrefix ? [input.request.pathPrefix] : []),
  ]
  const result = await runGit({
    directory: input.directory,
    args,
    maxOutputBytes: input.maxOutputBytes,
    signal: input.signal,
  })
  const commandFailure = gitCommandFailure(result, { allowNoMatches: true, allowTruncated: true })
  if (commandFailure) return failure('search_text', commandFailure)
  const output = decodeUtf8(result.stdout)
  if (output === undefined) return failure('search_text', 'repository_search_output_invalid')

  const parsed = parseGitGrepOutput(output, input.headSha)
  let matches = parsed.matches.slice(0, MAX_SEARCH_MATCHES)
  let truncated = result.truncated || parsed.invalid || parsed.matches.length > matches.length
  while (matches.length > 0 && utf8Bytes(JSON.stringify(matches)) > input.maxOutputBytes) {
    matches.pop()
    truncated = true
  }
  const bytes = utf8Bytes(JSON.stringify(matches))
  const persistenceFailure = recordRepositoryOutput(input.identity, bytes)
  if (persistenceFailure) return failure('search_text', persistenceFailure)

  return {
    ok: true,
    action: 'search_text',
    headSha: input.headSha,
    query: input.request.query,
    ...(input.request.pathPrefix ? { pathPrefix: input.request.pathPrefix } : {}),
    matches,
    bytes,
    truncated,
    diagnostics: truncated ? ['repository_search_output_truncated'] : [],
  }
}

function reviewHeadSha(run: ReviewRunRecord) {
  const trigger = run.trigger
  const candidate = trigger?.objectType === 'mr'
    ? trigger.headSha
    : trigger?.objectType === 'commit'
      ? trigger.commitSha
      : undefined
  return typeof candidate === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate)
    ? candidate.toLowerCase()
    : undefined
}

function projectSnapshotMatches(run: ReviewRunRecord) {
  const triggerProjectId = run.trigger?.projectId
  return Boolean(
    run.project
    && run.project.nine1botProjectID
    && (typeof triggerProjectId === 'string' || typeof triggerProjectId === 'number')
    && String(run.project.projectId) === String(triggerProjectId),
  )
}

function validateRequest(request: GitLabRepositorySessionRequest):
  | { ok: true; request: GitLabRepositorySessionRequest }
  | { ok: false; diagnostic: string } {
  if (request.action === 'read_file') {
    if (!validGitPath(request.path)) return { ok: false, diagnostic: 'repository_path_invalid' }
    if (request.startLine !== undefined && !boundedPositiveInteger(request.startLine, 100_000)) {
      return { ok: false, diagnostic: 'repository_line_range_invalid' }
    }
    if (request.maxLines !== undefined && !boundedPositiveInteger(request.maxLines, MAX_READ_LINES)) {
      return { ok: false, diagnostic: 'repository_line_range_invalid' }
    }
    return { ok: true, request }
  }
  if (
    !request.query
    || utf8Bytes(request.query) > MAX_SEARCH_QUERY_BYTES
    || /[\u0000-\u001f\u007f]/.test(request.query)
  ) {
    return { ok: false, diagnostic: 'repository_search_query_invalid' }
  }
  if (request.pathPrefix !== undefined && !validGitPath(request.pathPrefix)) {
    return { ok: false, diagnostic: 'repository_path_invalid' }
  }
  return { ok: true, request }
}

function validGitPath(path: string) {
  if (!path || utf8Bytes(path) > MAX_GIT_PATH_BYTES) return false
  if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && segment !== '.git')
}

function boundedPositiveInteger(value: number, maximum: number) {
  return Number.isInteger(value) && value > 0 && value <= maximum
}

function reserveRepositoryQuery(identity: ReviewRunIdentity, action: GitLabRepositorySessionRequest['action']):
  | { ok: true; maxOutputBytes: number }
  | { ok: false; diagnostic: string } {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return { ok: false, diagnostic: currentResult.diagnostic }
  const current = currentResult.run
  const repository = current.repository
  if (!repository) return { ok: false, diagnostic: 'repository_directory_not_bound' }
  const queryCount = normalizedCounter(repository.queryCount)
  const outputBytes = normalizedCounter(repository.outputBytes)
  if (queryCount >= MAX_REPOSITORY_QUERIES) {
    return { ok: false, diagnostic: 'repository_query_limit_reached' }
  }
  if (outputBytes >= MAX_REPOSITORY_OUTPUT_BYTES) {
    return { ok: false, diagnostic: 'repository_output_limit_reached' }
  }
  const updated = ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      queryCount: queryCount + 1,
      readCount: normalizedCounter(repository.readCount) + (action === 'read_file' ? 1 : 0),
      searchCount: normalizedCounter(repository.searchCount) + (action === 'search_text' ? 1 : 0),
      outputBytes,
    },
  })
  return updated
    ? { ok: true, maxOutputBytes: Math.min(MAX_TOOL_CONTENT_BYTES, MAX_REPOSITORY_OUTPUT_BYTES - outputBytes) }
    : { ok: false, diagnostic: 'repository_review_attempt_stale' }
}

function recordRepositoryOutput(identity: ReviewRunIdentity, bytes: number) {
  const currentResult = currentActiveReviewRun(identity)
  if ('diagnostic' in currentResult) return currentResult.diagnostic
  const repository = currentResult.run.repository
  if (!repository) return 'repository_directory_not_bound'
  const currentBytes = normalizedCounter(repository.outputBytes)
  if (bytes > MAX_REPOSITORY_OUTPUT_BYTES - currentBytes) return 'repository_output_limit_reached'
  return ReviewRunStore.updateIfCurrent(identity, {
    repository: {
      ...repository,
      outputBytes: currentBytes + bytes,
    },
  }) ? undefined : 'repository_review_attempt_stale'
}

function normalizedCounter(value: number | undefined) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

type RepositoryLifecycleDiagnostic =
  | 'repository_review_attempt_stale'
  | 'repository_review_run_not_active'
  | 'repository_request_aborted'

function repositoryLifecycleFailure(
  identity: ReviewRunIdentity,
  signal?: AbortSignal,
): RepositoryLifecycleDiagnostic | undefined {
  if (signal?.aborted) return 'repository_request_aborted'
  const currentResult = currentActiveReviewRun(identity)
  return 'diagnostic' in currentResult ? currentResult.diagnostic : undefined
}

function currentActiveReviewRun(identity: ReviewRunIdentity):
  | { run: ReviewRunRecord }
  | { diagnostic: Exclude<RepositoryLifecycleDiagnostic, 'repository_request_aborted'> } {
  const current = ReviewRunStore.get(identity.runId)
  if (
    !current
    || current.generation !== identity.generation
    || current.sessionId !== identity.sessionId
    || ReviewRunStore.findLatestByTriggerKey(current.triggerKey)?.id !== current.id
  ) {
    return { diagnostic: 'repository_review_attempt_stale' }
  }
  if (current.status !== 'accepted' && current.status !== 'running') {
    return { diagnostic: 'repository_review_run_not_active' }
  }
  return { run: current }
}

function logicalLines(source: string) {
  if (!source) return []
  const lines = source.split('\n')
  if (source.endsWith('\n')) lines.pop()
  return lines
}

function parseGitGrepOutput(output: string, headSha: string) {
  const matches: GitLabRepositoryMatch[] = []
  let cursor = 0
  let invalid = false
  while (cursor < output.length) {
    const pathEnd = output.indexOf('\0', cursor)
    const lineEnd = pathEnd >= 0 ? output.indexOf('\0', pathEnd + 1) : -1
    const textEnd = lineEnd >= 0 ? output.indexOf('\n', lineEnd + 1) : -1
    if (pathEnd < 0 || lineEnd < 0) {
      invalid = true
      break
    }
    const rawPath = output.slice(cursor, pathEnd)
    const lineValue = output.slice(pathEnd + 1, lineEnd)
    const text = output.slice(lineEnd + 1, textEnd >= 0 ? textEnd : output.length).replace(/\r$/, '')
    const prefix = `${headSha}:`
    const path = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : ''
    const line = Number.parseInt(lineValue, 10)
    if (!validGitPath(path) || !Number.isSafeInteger(line) || line <= 0) invalid = true
    else matches.push({ path, line, text })
    if (textEnd < 0) break
    cursor = textEnd + 1
  }
  return { matches, invalid }
}

function boundedUtf8Prefix(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false }
  let low = 0
  let high = value.length
  let best = ''
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2)
    const candidate = safeCodeUnitPrefix(value, midpoint)
    if (utf8Bytes(candidate) <= maxBytes) {
      best = candidate
      low = midpoint + 1
    } else {
      high = midpoint - 1
    }
  }
  return { value: best, truncated: true }
}

function safeCodeUnitPrefix(value: string, length: number) {
  let end = Math.min(value.length, Math.max(0, length))
  if (
    end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/.test(value[end]!)
  ) end -= 1
  return value.slice(0, end)
}

function decodeUtf8(value: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return undefined
  }
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

type GitCommandResult = {
  exitCode: number | null
  stdout: Uint8Array
  truncated: boolean
  timedOut: boolean
  aborted: boolean
  spawnFailed: boolean
}

function runGit(input: {
  directory: string
  args: string[]
  maxOutputBytes: number
  signal?: AbortSignal
}): Promise<GitCommandResult> {
  if (input.signal?.aborted) {
    return Promise.resolve(emptyGitResult({ aborted: true }))
  }
  return new Promise((resolveResult) => {
    let settled = false
    let timedOut = false
    let aborted = false
    let spawnFailed = false
    let truncated = false
    let outputBytes = 0
    const chunks: Uint8Array[] = []
    let child: ReturnType<typeof spawn>
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abort)
      const stdout = new Uint8Array(outputBytes)
      let offset = 0
      for (const chunk of chunks) {
        stdout.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolveResult({ exitCode, stdout, truncated, timedOut, aborted, spawnFailed })
    }
    const stop = () => {
      if (!child.killed) child.kill()
    }
    const abort = () => {
      aborted = true
      stop()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, GIT_COMMAND_TIMEOUT_MS)

    try {
      child = spawn('git', input.args, {
        cwd: input.directory,
        env: gitLabReviewRepositoryGitEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      spawnFailed = true
      finish(null)
      return
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    child.stderr?.resume()
    child.stdout?.on('data', (chunk: Uint8Array) => {
      const remaining = Math.max(0, input.maxOutputBytes - outputBytes)
      if (remaining > 0) {
        const included = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
        chunks.push(new Uint8Array(included))
        outputBytes += included.byteLength
      }
      if (chunk.byteLength > remaining) {
        truncated = true
        stop()
      }
    })
    child.once('error', () => {
      spawnFailed = true
    })
    child.once('close', (exitCode) => finish(exitCode))
  })
}

function emptyGitResult(patch: Partial<GitCommandResult> = {}): GitCommandResult {
  return {
    exitCode: null,
    stdout: new Uint8Array(),
    truncated: false,
    timedOut: false,
    aborted: false,
    spawnFailed: false,
    ...patch,
  }
}

function gitCommandFailure(
  result: GitCommandResult,
  options: { allowNoMatches?: boolean; allowTruncated?: boolean } = {},
) {
  if (result.aborted) return 'repository_request_aborted'
  if (result.timedOut) return 'repository_git_timeout'
  if (result.spawnFailed) return 'repository_git_unavailable'
  if (result.truncated && !options.allowTruncated) return 'repository_git_output_limit_reached'
  if (result.exitCode === 0) return undefined
  if (options.allowNoMatches && result.exitCode === 1 && !result.truncated) return undefined
  if (options.allowTruncated && result.truncated) return undefined
  return 'repository_git_command_failed'
}

function failure(
  action: GitLabRepositorySessionRequest['action'],
  diagnostic: string,
): GitLabRepositoryToolOutput {
  return { ok: false, action, diagnostic }
}
