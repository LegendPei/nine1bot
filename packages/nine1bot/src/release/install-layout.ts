import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function resolveInstallDir(input: {
  override?: string
  compiled: boolean
  execPath: string
  sourceFileUrl: string
}): string {
  const override = input.override?.trim()
  if (override) return normalize(resolve(override))
  if (input.compiled) return dirname(normalize(resolve(input.execPath)))

  return normalize(resolve(
    dirname(fileURLToPath(input.sourceFileUrl)),
    '..',
    '..',
    '..',
    '..',
  ))
}

export function resolvePackageResourcesRoot(input: {
  installDir: string
  compiled: boolean
}): string {
  return normalize(join(
    input.installDir,
    input.compiled ? 'platform-resources' : 'packages',
  ))
}
