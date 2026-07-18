import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path'

export type PlatformResourceManifestEntry = {
  source: string
  files: string[]
}

export type PlatformPackageManifestEntry = {
  name: string
  directory: string
  resources: PlatformResourceManifestEntry[]
}

export type PlatformResourcesManifest = {
  schemaVersion: 1
  packages: PlatformPackageManifestEntry[]
}

type PlannedResource = PlatformResourceManifestEntry & {
  sourceDirectory: string
  outputDirectory: string
}

type PlannedPackage = PlatformPackageManifestEntry & {
  plannedResources: PlannedResource[]
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortStrings(values: string[]): string[] {
  return values.sort((left, right) => left.localeCompare(right))
}

function toManifestPath(value: string): string {
  return value.split(sep).join('/')
}

function isOutside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function assertContained(root: string, target: string, label: string): void {
  if (isOutside(root, target)) {
    throw new Error(`${label} must stay inside ${root}: ${target}`)
  }
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty relative path`)
  }
  if (isAbsolute(value) || posix.isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`${label} must not be absolute: ${value}`)
  }

  const segments = value.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`${label} must not contain parent traversal: ${value}`)
  }
  if (segments.some((segment) => segment === '' || segment === '.')) {
    throw new Error(`${label} contains an empty or current-directory segment: ${value}`)
  }

  return segments.join('/')
}

async function collectFiles(root: string, label: string): Promise<string[]> {
  const rootStats = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${root}`)
    }
    throw error
  })
  if (rootStats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${root}`)
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${root}`)
  }

  const files: string[] = []
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory)
    sortStrings(entries)
    for (const name of entries) {
      const absolutePath = join(directory, name)
      const manifestPath = prefix ? `${prefix}/${name}` : name
      const stats = await lstat(absolutePath)
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${absolutePath}`)
      }
      if (stats.isDirectory()) {
        await visit(absolutePath, manifestPath)
        continue
      }
      if (!stats.isFile()) {
        throw new Error(`${label} contains an unsupported filesystem entry: ${absolutePath}`)
      }
      files.push(manifestPath)
    }
  }

  await visit(root, '')
  return sortStrings(files)
}

function validateResourceContents(source: string, files: string[], label: string): void {
  if (files.length === 0) {
    throw new Error(`${label} must not be empty`)
  }

  const kind = basename(source)
  if (kind === 'skills' && !files.some((file) => basename(file) === 'SKILL.md')) {
    throw new Error(`${label} must contain at least one SKILL.md`)
  }
  if (kind === 'agents' && !files.some((file) => file.endsWith('.agent.md'))) {
    throw new Error(`${label} must contain at least one *.agent.md`)
  }
}

async function planPackages(projectRoot: string, outputRoot: string): Promise<PlannedPackage[]> {
  const packagesRoot = join(projectRoot, 'packages')
  const packageDirectories = await readdir(packagesRoot, { withFileTypes: true })
  const plans: PlannedPackage[] = []
  const outputDirectories = new Set<string>()

  for (const entry of packageDirectories.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue

    const packageRoot = join(packagesRoot, entry.name)
    const packageJsonPath = join(packageRoot, 'package.json')
    const packageJsonText = await readFile(packageJsonPath, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (packageJsonText === undefined) continue

    let packageJson: unknown
    try {
      packageJson = JSON.parse(packageJsonText)
    } catch (error) {
      throw new Error(`Invalid JSON in ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(packageJson)) continue
    const nine1bot = packageJson.nine1bot
    if (nine1bot === undefined) continue
    if (!isRecord(nine1bot) || !Object.hasOwn(nine1bot, 'releaseResources')) continue

    const declaredResources = nine1bot.releaseResources
    if (!Array.isArray(declaredResources) || declaredResources.length === 0) {
      throw new Error(`${packageJsonPath}: nine1bot.releaseResources must be a non-empty array`)
    }
    if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
      throw new Error(`${packageJsonPath}: package name must be a non-empty string`)
    }

    const directory = packageJson.name.split('/').at(-1) ?? ''
    if (!directory.startsWith('platform-')) {
      throw new Error(`${packageJsonPath}: platform package name must end with platform-*: ${packageJson.name}`)
    }
    if (directory !== entry.name) {
      throw new Error(`${packageJsonPath}: package directory must match package name ${directory}`)
    }
    if (outputDirectories.has(directory)) {
      throw new Error(`${packageJsonPath}: duplicate platform output directory ${directory}`)
    }
    outputDirectories.add(directory)

    const normalizedResources = declaredResources.map((resource, index) => normalizeRelativePath(
      resource,
      `${packageJsonPath}: releaseResources[${index}]`,
    ))
    const uniqueResources = new Set(normalizedResources)
    if (uniqueResources.size !== normalizedResources.length) {
      throw new Error(`${packageJsonPath}: duplicate release resource declaration`)
    }

    const plannedResources: PlannedResource[] = []
    for (const source of sortStrings(normalizedResources)) {
      const segments = source.split('/')
      const sourceDirectory = resolve(packageRoot, ...segments)
      const packageOutputRoot = join(outputRoot, directory)
      const outputDirectory = resolve(packageOutputRoot, ...segments)
      assertContained(packageRoot, sourceDirectory, 'Platform resource source')
      assertContained(packageOutputRoot, outputDirectory, 'Platform resource output')
      const label = `${packageJson.name} resource ${source}`
      const files = await collectFiles(sourceDirectory, label)
      validateResourceContents(source, files, label)
      plannedResources.push({ source, files, sourceDirectory, outputDirectory })
    }

    plans.push({
      name: packageJson.name,
      directory,
      resources: plannedResources.map(({ source, files }) => ({ source, files })),
      plannedResources,
    })
  }

  return plans.sort((left, right) => left.directory.localeCompare(right.directory))
}

function manifestFromPlans(plans: PlannedPackage[]): PlatformResourcesManifest {
  return {
    schemaVersion: 1,
    packages: plans.map(({ name, directory, resources }) => ({ name, directory, resources })),
  }
}

function parseManifest(value: unknown, manifestPath: string): PlatformResourcesManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.packages)) {
    throw new Error(`Invalid platform resources manifest: ${manifestPath}`)
  }

  const packages: PlatformPackageManifestEntry[] = value.packages.map((item, packageIndex) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !Array.isArray(item.resources)) {
      throw new Error(`Invalid package entry ${packageIndex} in ${manifestPath}`)
    }
    const directory = normalizeRelativePath(
      item.directory,
      `Manifest package ${packageIndex} directory`,
    )
    if (directory.includes('/') || !directory.startsWith('platform-')) {
      throw new Error(`Invalid platform package directory in ${manifestPath}: ${directory}`)
    }

    const resources = item.resources.map((resource, resourceIndex) => {
      if (!isRecord(resource) || !Array.isArray(resource.files)) {
        throw new Error(`Invalid resource entry ${resourceIndex} in ${manifestPath}`)
      }
      const source = normalizeRelativePath(
        resource.source,
        `Manifest resource ${packageIndex}.${resourceIndex} source`,
      )
      const files = resource.files.map((file, fileIndex) => normalizeRelativePath(
        file,
        `Manifest resource ${packageIndex}.${resourceIndex} file ${fileIndex}`,
      ))
      if (files.length === 0 || new Set(files).size !== files.length) {
        throw new Error(`Manifest resource ${directory}/${source} has empty or duplicate files`)
      }
      if (JSON.stringify(files) !== JSON.stringify(sortStrings([...files]))) {
        throw new Error(`Manifest files are not sorted for ${directory}/${source}`)
      }
      return { source, files }
    })

    if (resources.length === 0) {
      throw new Error(`Manifest package ${directory} has no resources`)
    }
    const resourceSources = resources.map((resource) => resource.source)
    if (new Set(resourceSources).size !== resourceSources.length) {
      throw new Error(`Manifest package ${directory} has duplicate resources`)
    }
    if (JSON.stringify(resourceSources) !== JSON.stringify(sortStrings([...resourceSources]))) {
      throw new Error(`Manifest resources are not sorted for ${directory}`)
    }
    return { name: item.name, directory, resources }
  })

  const directories = packages.map((item) => item.directory)
  if (new Set(directories).size !== directories.length) {
    throw new Error(`Manifest has duplicate platform package directories: ${manifestPath}`)
  }
  if (JSON.stringify(directories) !== JSON.stringify(sortStrings([...directories]))) {
    throw new Error(`Manifest packages are not sorted: ${manifestPath}`)
  }

  return { schemaVersion: 1, packages }
}

export async function packagePlatformResources(options: {
  projectRoot: string
  buildDir: string
}): Promise<PlatformResourcesManifest> {
  const projectRoot = resolve(options.projectRoot)
  const distRoot = join(projectRoot, 'dist')
  const buildDir = resolve(options.buildDir)
  const buildRelative = relative(distRoot, buildDir)
  if (
    buildRelative.length === 0
    || buildRelative === '..'
    || buildRelative.startsWith(`..${sep}`)
    || isAbsolute(buildRelative)
  ) {
    throw new Error(`Build directory must be inside the project dist directory: ${buildDir}`)
  }

  const outputRoot = join(buildDir, 'platform-resources')
  assertContained(buildDir, outputRoot, 'Platform resources output')
  const plans = await planPackages(projectRoot, outputRoot)
  if (plans.length === 0) {
    throw new Error(`No packages declare nine1bot.releaseResources under ${join(projectRoot, 'packages')}`)
  }
  const manifest = manifestFromPlans(plans)

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  for (const plan of plans) {
    for (const resource of plan.plannedResources) {
      for (const file of resource.files) {
        const sourceFile = resolve(resource.sourceDirectory, ...file.split('/'))
        const outputFile = resolve(resource.outputDirectory, ...file.split('/'))
        assertContained(resource.sourceDirectory, sourceFile, 'Platform resource file')
        assertContained(resource.outputDirectory, outputFile, 'Packaged platform resource file')
        await mkdir(dirname(outputFile), { recursive: true })
        await copyFile(sourceFile, outputFile)
      }
    }
  }

  await writeFile(
    join(outputRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
  await verifyPlatformResources({ buildDir })
  return manifest
}

export async function verifyPlatformResources(options: {
  buildDir: string
}): Promise<PlatformResourcesManifest> {
  const outputRoot = resolve(options.buildDir, 'platform-resources')
  const manifestPath = join(outputRoot, 'manifest.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read platform resources manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = parseManifest(parsed, manifestPath)

  const expectedFiles: string[] = []
  for (const platformPackage of manifest.packages) {
    for (const resource of platformPackage.resources) {
      for (const file of resource.files) {
        expectedFiles.push(`${platformPackage.directory}/${resource.source}/${file}`)
      }
    }
  }
  sortStrings(expectedFiles)
  if (new Set(expectedFiles).size !== expectedFiles.length) {
    throw new Error(`Platform resources manifest describes duplicate output files: ${manifestPath}`)
  }

  const actualFiles = (await collectFiles(outputRoot, 'Packaged platform resources'))
    .filter((file) => file !== 'manifest.json')
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `Packaged platform resource tree does not match manifest. Expected ${JSON.stringify(expectedFiles)}, received ${JSON.stringify(actualFiles)}`,
    )
  }

  return manifest
}
