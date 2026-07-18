import { stat } from 'node:fs/promises'
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path'
import { parseArgs } from 'node:util'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredValue(value: string | undefined, option: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required --${option} value`)
  }
  return value
}

function sourceList(value: unknown, label: string): JsonRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`${label} must be an array of runtime source objects`)
  }
  return value
}

function isOutside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

export async function checkPlatformRuntimeResources(options: {
  buildDir: string
  platformDetails: unknown[]
}): Promise<{ bundledSourceCount: number }> {
  const packagedRoot = resolve(options.buildDir, 'platform-resources')
  let bundledSourceCount = 0

  for (const detailValue of options.platformDetails) {
    if (!isRecord(detailValue)) {
      throw new Error('Platform detail response must be an object')
    }
    const platformID = typeof detailValue.id === 'string' ? detailValue.id : '<unknown>'
    const runtimeSources = detailValue.runtimeSources
    if (runtimeSources === undefined) continue
    if (!isRecord(runtimeSources)) {
      throw new Error(`Platform ${platformID} runtimeSources must be an object`)
    }

    const sources = [
      ...sourceList(runtimeSources.agents, `Platform ${platformID} agents`),
      ...sourceList(runtimeSources.skills, `Platform ${platformID} skills`),
    ]
    for (const source of sources) {
      const sourceID = typeof source.id === 'string' ? source.id : '<unknown>'
      if (typeof source.directory !== 'string' || source.directory.length === 0) {
        throw new Error(`Platform ${platformID} runtime source ${sourceID} has no directory`)
      }
      if (/(?:^|[\\/])~BUN(?:[\\/]|$)/i.test(source.directory)) {
        throw new Error(
          `Platform ${platformID} runtime source ${sourceID} uses Bun virtual filesystem path: ${source.directory}`,
        )
      }
      if (
        !isAbsolute(source.directory)
        && !posix.isAbsolute(source.directory)
        && !win32.isAbsolute(source.directory)
      ) {
        throw new Error(
          `Platform ${platformID} runtime source ${sourceID} directory must be absolute: ${source.directory}`,
        )
      }

      const directory = resolve(source.directory)
      if (isOutside(packagedRoot, directory)) continue

      if (source.status !== 'registered') {
        throw new Error(
          `Bundled runtime source ${platformID}/${sourceID} must be registered, received ${String(source.status)}`,
        )
      }
      const stats = await stat(directory).catch((error) => {
        throw new Error(
          `Bundled runtime source ${platformID}/${sourceID} is unavailable at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      if (!stats.isDirectory()) {
        throw new Error(`Bundled runtime source ${platformID}/${sourceID} is not a directory: ${directory}`)
      }
      bundledSourceCount += 1
    }
  }

  if (bundledSourceCount === 0) {
    throw new Error(`No bundled platform runtime sources were reported below ${packagedRoot}`)
  }
  return { bundledSourceCount }
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}): ${url}`)
  }
  return await response.json()
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'base-url': { type: 'string' },
      'build-dir': { type: 'string' },
    },
    strict: true,
  })
  const baseURL = requiredValue(values['base-url'], 'base-url')
  const buildDir = requiredValue(values['build-dir'], 'build-dir')
  const rootURL = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`)
  const platformsURL = new URL('nine1bot/platforms/', rootURL)
  const listResponse = await fetchJson(platformsURL)
  if (!isRecord(listResponse) || !Array.isArray(listResponse.platforms)) {
    throw new Error(`Invalid platform list response from ${platformsURL}`)
  }

  const enabledPlatformIDs = listResponse.platforms.map((summary, index) => {
    if (!isRecord(summary) || typeof summary.id !== 'string' || typeof summary.enabled !== 'boolean') {
      throw new Error(`Invalid platform summary at index ${index}`)
    }
    return summary.enabled ? summary.id : undefined
  }).filter((id): id is string => id !== undefined)

  const platformDetails = await Promise.all(enabledPlatformIDs.map((id) => (
    fetchJson(new URL(encodeURIComponent(id), platformsURL))
  )))
  const result = await checkPlatformRuntimeResources({ buildDir, platformDetails })
  console.log(
    `Verified ${result.bundledSourceCount} bundled runtime sources across ${enabledPlatformIDs.length} enabled platforms`,
  )
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
