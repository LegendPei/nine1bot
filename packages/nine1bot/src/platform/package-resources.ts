import type { PlatformPackageResources } from '@nine1bot/platform-protocol'
import {
  isAbsolute,
  normalize,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path'

function isOutside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function packageDirectory(packageName: string): string {
  if (packageName.length === 0) {
    throw new Error('Platform package name must be non-empty')
  }
  const directory = packageName.split('/').at(-1) ?? ''
  if (!/^platform-[a-z0-9][a-z0-9-]*$/.test(directory)) {
    throw new Error(`Platform package name must end with a platform-* directory: ${packageName}`)
  }
  return directory
}

export function createPlatformPackageResources(
  resourcesRoot: string,
  packageName: string,
): PlatformPackageResources {
  const root = normalize(resolve(resourcesRoot, packageDirectory(packageName)))
  return {
    root,
    resolve(...segments: string[]): string {
      if (segments.length === 0) {
        throw new Error(`Platform package resource path requires at least one segment: ${packageName}`)
      }
      for (const segment of segments) {
        if (segment.length === 0) {
          throw new Error(`Platform package resource path contains an empty segment: ${packageName}`)
        }
        if (isAbsolute(segment) || posix.isAbsolute(segment) || win32.isAbsolute(segment)) {
          throw new Error(`Platform package resource path must not contain an absolute segment: ${segment}`)
        }
      }

      const target = normalize(resolve(root, ...segments))
      if (isOutside(root, target)) {
        throw new Error(`Platform package resource path resolves outside ${root}: ${segments.join('/')}`)
      }
      return target
    },
  }
}
