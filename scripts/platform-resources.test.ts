import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { packagePlatformResources, verifyPlatformResources } from './platform-resources'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'nine1bot-platform-resources-'))
  roots.push(projectRoot)
  const buildDir = join(projectRoot, 'dist', 'nine1bot-test-x64')
  await mkdir(buildDir, { recursive: true })
  return { projectRoot, buildDir }
}

async function writePackage(
  projectRoot: string,
  directory: string,
  name: string,
  releaseResources: string[],
) {
  const root = join(projectRoot, 'packages', directory)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name,
    nine1bot: { releaseResources },
  }, null, 2), 'utf8')
  return root
}

async function writeSkill(root: string, name = 'example') {
  await mkdir(join(root, 'skills', name), { recursive: true })
  await writeFile(join(root, 'skills', name, 'SKILL.md'), `# ${name}`, 'utf8')
}

async function writeAgent(root: string, name = 'developer') {
  await mkdir(join(root, 'agents', 'review'), { recursive: true })
  await writeFile(join(root, 'agents', 'review', `${name}.agent.md`), `# ${name}`, 'utf8')
}

describe('platform release resources', () => {
  test('copies declared resources and writes a stable manifest', async () => {
    const { projectRoot, buildDir } = await fixture()
    const feishu = await writePackage(
      projectRoot,
      'platform-feishu',
      '@nine1bot/platform-feishu',
      ['skills'],
    )
    const gitlab = await writePackage(
      projectRoot,
      'platform-gitlab',
      '@nine1bot/platform-gitlab',
      ['skills', 'agents'],
    )
    await writeSkill(feishu, 'feishu-current-page')
    await writeSkill(gitlab, 'review/workflow')
    await writeAgent(gitlab)

    const manifest = await packagePlatformResources({ projectRoot, buildDir })

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.packages.map((item) => item.directory)).toEqual([
      'platform-feishu',
      'platform-gitlab',
    ])
    expect(manifest.packages[1]?.resources.map((item) => item.source)).toEqual(['agents', 'skills'])
    expect(await Bun.file(join(
      buildDir,
      'platform-resources',
      'platform-feishu',
      'skills',
      'feishu-current-page',
      'SKILL.md',
    )).text()).toBe('# feishu-current-page')
    await expect(verifyPlatformResources({ buildDir })).resolves.toEqual(manifest)

    const serialized = await readFile(
      join(buildDir, 'platform-resources', 'manifest.json'),
      'utf8',
    )
    expect(serialized).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
  })

  test.each([
    ['a parent traversal', '../outside'],
    ['a nested parent traversal', 'skills/../outside'],
    ['a POSIX absolute path', '/outside'],
    ['a Windows absolute path', 'C:\\outside'],
  ])('rejects %s declaration', async (_label, resource) => {
    const { projectRoot, buildDir } = await fixture()
    await writePackage(projectRoot, 'platform-demo', '@nine1bot/platform-demo', [resource])

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow(
      isAbsolute(resource) || /^[A-Za-z]:[\\/]/.test(resource) ? 'absolute' : 'parent traversal',
    )
  })

  test('rejects duplicate declarations before replacing existing output', async () => {
    const { projectRoot, buildDir } = await fixture()
    await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      ['skills', 'skills'],
    )
    const marker = join(buildDir, 'platform-resources', 'keep.txt')
    await mkdir(join(buildDir, 'platform-resources'), { recursive: true })
    await writeFile(marker, 'keep', 'utf8')

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow('duplicate')
    expect(await Bun.file(marker).text()).toBe('keep')
  })

  test('rejects empty resource directories', async () => {
    const { projectRoot, buildDir } = await fixture()
    const platform = await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      ['skills'],
    )
    await mkdir(join(platform, 'skills'), { recursive: true })

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow('empty')
  })

  test('rejects symbolic links anywhere below a declared directory', async () => {
    const { projectRoot, buildDir } = await fixture()
    const platform = await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      ['skills'],
    )
    await writeSkill(platform)
    const target = join(projectRoot, 'link-target')
    await mkdir(target)
    await writeFile(join(target, 'secret.txt'), 'secret', 'utf8')
    await symlink(target, join(platform, 'skills', 'linked'), 'junction')

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow('symbolic link')
  })

  test.each([
    ['skills', 'SKILL.md'],
    ['agents', '*.agent.md'],
  ])('rejects a %s directory without %s', async (resource, expectedFile) => {
    const { projectRoot, buildDir } = await fixture()
    const platform = await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      [resource],
    )
    await mkdir(join(platform, resource), { recursive: true })
    await writeFile(join(platform, resource, 'README.md'), '# Invalid', 'utf8')

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow(expectedFile)
  })

  test('removes stale platform-resource output on a second invocation', async () => {
    const { projectRoot, buildDir } = await fixture()
    const platform = await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      ['skills'],
    )
    await writeSkill(platform)
    await packagePlatformResources({ projectRoot, buildDir })
    const stale = join(buildDir, 'platform-resources', 'stale.txt')
    await writeFile(stale, 'stale', 'utf8')

    await packagePlatformResources({ projectRoot, buildDir })

    expect(await Bun.file(stale).exists()).toBe(false)
    await expect(verifyPlatformResources({ buildDir })).resolves.toBeDefined()
  })

  test('detects exact manifest and tree mismatches', async () => {
    const { projectRoot, buildDir } = await fixture()
    const platform = await writePackage(
      projectRoot,
      'platform-demo',
      '@nine1bot/platform-demo',
      ['skills'],
    )
    await writeSkill(platform)
    await packagePlatformResources({ projectRoot, buildDir })
    await writeFile(
      join(buildDir, 'platform-resources', 'platform-demo', 'skills', 'unexpected.txt'),
      'unexpected',
      'utf8',
    )

    await expect(verifyPlatformResources({ buildDir })).rejects.toThrow('does not match manifest')
  })

  test('refuses to clean a build directory outside project dist', async () => {
    const { projectRoot } = await fixture()
    const buildDir = join(projectRoot, 'outside-build')
    await mkdir(buildDir)

    await expect(packagePlatformResources({ projectRoot, buildDir })).rejects.toThrow(
      'inside the project dist directory',
    )
  })
})
