import { describe, expect, test } from 'bun:test'
import { join, normalize } from 'node:path'
import { createPlatformPackageResources } from './package-resources'

describe('createPlatformPackageResources', () => {
  test('maps a scoped package to its isolated directory', () => {
    const resourcesRoot = join(process.cwd(), 'release', 'platform-resources')
    const locator = createPlatformPackageResources(resourcesRoot, '@nine1bot/platform-feishu')

    expect(locator.root).toBe(normalize(join(resourcesRoot, 'platform-feishu')))
    expect(locator.resolve('skills', 'feishu-current-page')).toBe(
      join(locator.root, 'skills', 'feishu-current-page'),
    )
  })

  test.each([
    [[], 'at least one'],
    [[''], 'empty'],
    [['../platform-gitlab/skills'], 'outside'],
    [['C:\\outside'], 'absolute'],
    [['/outside'], 'absolute'],
  ])('rejects unsafe path segments %j', (segments, message) => {
    const locator = createPlatformPackageResources(
      join(process.cwd(), 'release', 'platform-resources'),
      '@nine1bot/platform-feishu',
    )

    expect(() => locator.resolve(...segments)).toThrow(message)
  })

  test.each([
    ['@nine1bot/not-a-platform', 'platform-*'],
    ['@nine1bot/platform-feishu/extra', 'platform-*'],
    ['', 'non-empty'],
  ])('rejects invalid platform package name %j', (packageName, message) => {
    expect(() => createPlatformPackageResources(process.cwd(), packageName)).toThrow(message)
  })
})
