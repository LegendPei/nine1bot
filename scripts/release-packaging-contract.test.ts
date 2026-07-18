import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkPlatformRuntimeResources } from './probe-platform-runtime-resources'

const root = join(import.meta.dir, '..')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runtimeFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'nine1bot-runtime-probe-'))
  temporaryRoots.push(fixtureRoot)
  const buildDir = join(fixtureRoot, 'nine1bot-test')
  const skills = join(buildDir, 'platform-resources', 'platform-demo', 'skills')
  await mkdir(skills, { recursive: true })
  return { fixtureRoot, buildDir, skills }
}

describe('release packaging contract', () => {
  test('uses the generic platform resource packager', async () => {
    const script = await readFile(join(root, 'scripts', 'package.sh'), 'utf8')
    expect(script).toContain('package-platform-resources.ts')
    expect(script).toContain('Compress-Archive')
    expect(script).not.toContain('packages/platform-feishu/skills')
    expect(script).not.toContain('packages/platform-gitlab/skills')
  })

  test('checks static and running-binary platform resources', async () => {
    const script = await readFile(join(root, 'scripts', 'test-startup.sh'), 'utf8')
    expect(script).toContain('verify-platform-resources.ts')
    expect(script).toContain('probe-platform-runtime-resources.ts')
  })

  test('installs the full tree under Homebrew libexec with an install-root wrapper', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    expect(workflow).toContain('libexec.install Dir["#{build_dir}/*"]')
    expect(workflow).toContain('(bin/"nine1bot").write_env_script libexec/"nine1bot"')
    expect(workflow).toContain('NINE1BOT_INSTALL_DIR: libexec')
    expect(workflow).not.toContain('"#{build_dir}/packages"')
  })
})

describe('compiled platform runtime resource probe', () => {
  test('accepts registered bundled directories and ignores external sources', async () => {
    const { fixtureRoot, buildDir, skills } = await runtimeFixture()
    const external = join(fixtureRoot, 'external-skills')
    const result = await checkPlatformRuntimeResources({
      buildDir,
      platformDetails: [{
        id: 'demo',
        runtimeSources: {
          agents: [],
          skills: [
            { id: 'demo-skills', directory: skills, status: 'registered' },
            { id: 'external-skills', directory: external, status: 'error' },
          ],
        },
      }],
    })

    expect(result).toEqual({ bundledSourceCount: 1 })
  })

  test('rejects bundled sources that are not registered', async () => {
    const { buildDir, skills } = await runtimeFixture()

    await expect(checkPlatformRuntimeResources({
      buildDir,
      platformDetails: [{
        id: 'demo',
        runtimeSources: {
          skills: [{ id: 'demo-skills', directory: skills, status: 'error' }],
        },
      }],
    })).rejects.toThrow('must be registered')
  })

  test('rejects Bun virtual filesystem paths', async () => {
    const { buildDir } = await runtimeFixture()

    await expect(checkPlatformRuntimeResources({
      buildDir,
      platformDetails: [{
        id: 'demo',
        runtimeSources: {
          agents: [{ id: 'demo-agents', directory: 'B:\\~BUN\\agents', status: 'registered' }],
        },
      }],
    })).rejects.toThrow('Bun virtual filesystem')
  })

  test('requires at least one bundled runtime source', async () => {
    const { fixtureRoot, buildDir } = await runtimeFixture()
    const external = join(fixtureRoot, 'external-skills')

    await expect(checkPlatformRuntimeResources({
      buildDir,
      platformDetails: [{
        id: 'demo',
        runtimeSources: {
          skills: [{ id: 'external-skills', directory: external, status: 'registered' }],
        },
      }],
    })).rejects.toThrow('No bundled platform runtime sources')
  })
})
