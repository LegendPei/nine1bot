import { JsonFile } from '../../../../opencode/packages/opencode/src/util/json-file'

export async function updateConfigValue(
  configPath: string,
  path: Array<string | number>,
  value: unknown,
): Promise<void> {
  await JsonFile.update(configPath, (draft) => {
    let parent: any = draft
    for (let index = 0; index < path.length - 1; index++) {
      const key = path[index]!
      parent[key] ??= typeof path[index + 1] === 'number' ? [] : {}
      parent = parent[key]
    }
    const key = path[path.length - 1]!
    if (value === undefined) delete parent[key]
    else parent[key] = value
  })
}
