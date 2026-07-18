import { parseArgs } from 'node:util'
import { packagePlatformResources } from './platform-resources'

function requiredValue(value: string | undefined, option: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required --${option} value`)
  }
  return value
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'project-root': { type: 'string' },
      'build-dir': { type: 'string' },
    },
    strict: true,
  })
  const manifest = await packagePlatformResources({
    projectRoot: requiredValue(values['project-root'], 'project-root'),
    buildDir: requiredValue(values['build-dir'], 'build-dir'),
  })
  const resources = manifest.packages.reduce((count, item) => count + item.resources.length, 0)
  const files = manifest.packages.reduce(
    (count, item) => count + item.resources.reduce(
      (packageCount, resource) => packageCount + resource.files.length,
      0,
    ),
    0,
  )
  console.log(`Packaged ${manifest.packages.length} platform packages, ${resources} resources, ${files} files`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
