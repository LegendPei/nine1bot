import { execFile } from 'node:child_process'
import { sanitizeGitLabSecrets } from '../review/sanitizer'
import type { GitLabCliRunner, GitLabCliRunOptions, GitLabCliRunResult, GitLabCliStatus } from './types'

export const defaultGitLabCliTimeoutMs = 30_000
export const gitLabCliMaxOutputBytes = 4 * 1024 * 1024

export const runGlab: GitLabCliRunner = async (args, options = {}) => {
  const timeout = options.timeoutMs ?? defaultGitLabCliTimeoutMs
  return await new Promise<GitLabCliRunResult>((resolve) => {
    try {
      const child = execFile('glab', args, {
        cwd: options.cwd,
        timeout,
        windowsHide: true,
        maxBuffer: gitLabCliMaxOutputBytes + 64 * 1024,
        signal: options.signal,
      }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code
        resolve({
          stdout: stdout ?? '',
          stderr: stderr || error?.message || '',
          exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
          command: 'glab',
          args,
          ...(code === 'ABORT_ERR' || options.signal?.aborted ? { cancelled: true } : {}),
          ...(code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { outputTooLarge: true } : {}),
        })
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(options.stdin)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      resolve({
        stdout: '',
        stderr: err.message || '',
        exitCode: 1,
        command: 'glab',
        args,
        ...(err.code === 'ABORT_ERR' || options.signal?.aborted ? { cancelled: true } : {}),
      })
    }
  })
}

export async function getGitLabCliStatus(input: {
  runner?: GitLabCliRunner
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<GitLabCliStatus> {
  const runner = input.runner ?? runGlab
  const timeoutMs = input.timeoutMs ?? 10_000
  const version = await runner(['--version'], { cwd: input.cwd, timeoutMs, signal: input.signal })
  if (version.exitCode !== 0) {
    return {
      available: false,
      authenticated: false,
      message: statusMessage('GitLab CLI is not available.', version),
    }
  }

  const auth = await runner(['auth', 'status'], { cwd: input.cwd, timeoutMs, signal: input.signal })
  if (auth.exitCode !== 0) {
    return {
      available: true,
      version: parseGlabVersion(version.stdout || version.stderr),
      authenticated: false,
      message: statusMessage('GitLab CLI is installed but not authenticated.', auth),
    }
  }

  const authText = `${auth.stdout}\n${auth.stderr}`
  const parsed = parseGlabAuthStatus(authText)
  return {
    available: true,
    version: parseGlabVersion(version.stdout || version.stderr),
    authenticated: true,
    host: parsed.host,
    user: parsed.user,
    message: parsed.host
      ? `GitLab CLI is authenticated for ${parsed.host}${parsed.user ? ` as ${parsed.user}` : ''}.`
      : 'GitLab CLI is authenticated.',
  }
}

export function parseGlabVersion(output: string): string | undefined {
  const normalized = output.trim()
  const match = /glab\s+version\s+([^\s]+)/i.exec(normalized)
    ?? /version\s+([^\s]+)/i.exec(normalized)
  return boundedIdentity(match?.[1] ?? normalized.split(/\s+/).find((part) => /^\d+\.\d+/.test(part)), 128)
}

export function parseGlabAuthStatus(output: string): { host?: string; user?: string } {
  const host = boundedIdentity(
    /(?:Logged in to|gitlab host:|host:)\s+([^\s,]+)/i.exec(output)?.[1]
      ?? /([a-z0-9.-]*gitlab[a-z0-9.-]*)/i.exec(output)?.[1],
    255,
  )
  const user = boundedIdentity(/(?:as|user:|username:)\s+@?([A-Za-z0-9_.-]+)/i.exec(output)?.[1], 256)
  return { host, user }
}

function boundedIdentity(input: string | undefined, maxBytes: number) {
  if (!input || Buffer.byteLength(input, 'utf8') > maxBytes) return undefined
  return input
}

function statusMessage(prefix: string, result: GitLabCliRunResult) {
  const detail = sanitizeGitLabSecrets(result.stderr || result.stdout, {
    maxInputCodeUnits: 2_000,
    maxInputUtf8Bytes: 4_000,
    maxOutputCodeUnits: 500,
    maxOutputUtf8Bytes: 1_000,
  }).replace(/\s+/g, ' ').trim()
  return detail ? `${prefix} ${detail}` : prefix
}
