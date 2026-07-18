import { describe, expect, test } from 'bun:test'
import { dirname, join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { resolveInstallDir, resolvePackageResourcesRoot } from './install-layout'

describe('release install layout', () => {
  test('uses an explicit install root before every fallback', () => {
    const override = join(tmpdir(), 'Cellar', 'nine1bot', 'libexec')

    expect(resolveInstallDir({
      override,
      compiled: true,
      execPath: join(tmpdir(), 'Cellar', 'nine1bot', 'bin', 'nine1bot'),
      sourceFileUrl: pathToFileURL(join(
        process.cwd(),
        'packages',
        'nine1bot',
        'src',
        'config',
        'loader.ts',
      )).href,
    })).toBe(normalize(override))
  })

  test('uses the executable directory for every compiled layout', () => {
    const execPath = join(tmpdir(), 'portable', 'custom-name', 'nine1bot')

    expect(resolveInstallDir({
      compiled: true,
      execPath,
      sourceFileUrl: 'file:///ignored.ts',
    })).toBe(dirname(normalize(execPath)))
  })

  test('derives the workspace root only in source mode', () => {
    const workspaceRoot = normalize(join(tmpdir(), 'nine1bot-source'))
    const sourceFile = join(
      workspaceRoot,
      'packages',
      'nine1bot',
      'src',
      'config',
      'loader.ts',
    )

    expect(resolveInstallDir({
      compiled: false,
      execPath: join(tmpdir(), 'bun'),
      sourceFileUrl: pathToFileURL(sourceFile).href,
    })).toBe(workspaceRoot)
  })

  test('selects source and release package-resource roots', () => {
    const installDir = normalize(join(tmpdir(), 'nine1bot-install'))

    expect(resolvePackageResourcesRoot({ installDir, compiled: false }))
      .toBe(join(installDir, 'packages'))
    expect(resolvePackageResourcesRoot({ installDir, compiled: true }))
      .toBe(join(installDir, 'platform-resources'))
  })
})
