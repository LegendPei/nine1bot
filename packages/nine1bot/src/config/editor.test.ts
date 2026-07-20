import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateConfigValue } from './editor'
import { findConfigPath, resolveConfigContext } from './loader'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nine1bot-config-context-'))
  tempDirs.push(directory)
  return directory
}

describe('JSONC config editor', () => {
  it('updates one value without removing comments or unrelated formatting', async () => {
    const directory = await tempDirectory()
    const configPath = join(directory, 'config.jsonc')
    await writeFile(configPath, '{\n  // keep this comment\n  "server": { "port": 4096 },\n  "auth": { "enabled": false }\n}\n', 'utf8')

    await updateConfigValue(configPath, ['auth', 'enabled'], true)
    const updated = await readFile(configPath, 'utf8')

    expect(updated).toContain('// keep this comment')
    expect(updated).toContain('"server": { "port": 4096 }')
    expect(updated).toContain('"enabled": true')
  })
})

describe('config context', () => {
  it('finds the nearest project config while walking upward', async () => {
    const directory = await tempDirectory()
    const nested = join(directory, 'a', 'b')
    await mkdir(nested, { recursive: true })
    const configPath = join(directory, 'nine1bot.config.jsonc')
    await writeFile(configPath, '{}\n', 'utf8')

    expect(await findConfigPath(nested)).toBe(configPath)
  })

  it('uses an explicit config as the write target and reports field provenance', async () => {
    const directory = await tempDirectory()
    const configPath = join(directory, 'custom.jsonc')
    await writeFile(configPath, '{ "auth": { "enabled": true } }\n', 'utf8')

    const context = await resolveConfigContext({ customConfigPath: configPath })

    expect(context.writePath).toBe(configPath)
    expect(context.effective.auth.enabled).toBe(true)
    expect(context.sources.at(-1)).toEqual({ kind: 'explicit', path: configPath })
    expect(context.provenance['auth.enabled']).toBe(configPath)
    expect(context.provenance['auth.password']).toBe('schema-default')
  })

  it('does not report global config as an active source when isolation disables it', async () => {
    const directory = await tempDirectory()
    const configPath = join(directory, 'isolated.jsonc')
    await writeFile(configPath, JSON.stringify({
      isolation: { disableGlobalConfig: true },
      auth: { enabled: false },
    }), 'utf8')

    const context = await resolveConfigContext({ customConfigPath: configPath })
    expect(context.sources.some((source) => source.kind === 'global')).toBe(false)
    expect(context.provenance['auth.enabled']).toBe(configPath)
  })
})
