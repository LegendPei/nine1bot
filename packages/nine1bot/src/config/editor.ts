import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'

const formattingOptions: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
}

export async function updateConfigValue(
  configPath: string,
  path: Array<string | number>,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  const source = await readFile(configPath, 'utf8').catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '{}\n'
    throw error
  })
  const edits = modify(source, path, value, { formattingOptions })
  const updated = applyEdits(source, edits)
  await writeFile(configPath, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8')
}
