import { gitlabPlatformContribution } from '@nine1bot/platform-gitlab/runtime'
import { PlatformAdapterManager } from './manager'
import { getPlatformPackageResourcesRoot } from '../config/loader'

export function registerGitLabPlatformAdapter() {
  return new PlatformAdapterManager({
    contributions: [gitlabPlatformContribution],
    packageResourcesRoot: getPlatformPackageResourcesRoot(),
  }).registerRuntimeAdapters()
}
