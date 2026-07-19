import { afterEach, describe, expect, it } from 'bun:test'
import { api, type FileContent, type FileItem, type FileSearchResult } from '../src/api/client'
import { useFiles } from '../src/composables/useFiles'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const originalGetFiles = api.getFiles
const originalGetFileContent = api.getFileContent
const originalSearchFiles = api.searchFiles

afterEach(() => {
  api.getFiles = originalGetFiles
  api.getFileContent = originalGetFileContent
  api.searchFiles = originalSearchFiles
})

describe('useFiles out-of-order response guards', () => {
  it('loadFiles ignores stale responses that resolve after a newer request', async () => {
    const first = deferred<FileItem[]>()
    const second = deferred<FileItem[]>()
    let call = 0
    api.getFiles = (async () => (++call === 1 ? first.promise : second.promise)) as typeof api.getFiles

    const { files, loadFiles } = useFiles()
    const p1 = loadFiles('a')
    const p2 = loadFiles('b')

    second.resolve([{ name: 'new', path: 'b/new', type: 'file' }])
    await p2
    expect(files.value.map(f => f.name)).toEqual(['new'])

    first.resolve([{ name: 'stale', path: 'a/stale', type: 'file' }])
    await p1
    expect(files.value.map(f => f.name)).toEqual(['new'])
  })

  it('loadFileContent ignores stale responses and mismatched paths', async () => {
    const first = deferred<FileContent>()
    const second = deferred<FileContent>()
    let call = 0
    api.getFileContent = (async () => (++call === 1 ? first.promise : second.promise)) as typeof api.getFileContent

    const { fileContent, loadFileContent } = useFiles()
    const p1 = loadFileContent('a.ts')
    const p2 = loadFileContent('b.ts')

    second.resolve({ path: 'b.ts', content: 'new content' })
    await p2
    expect(fileContent.value?.content).toBe('new content')

    first.resolve({ path: 'a.ts', content: 'stale content' })
    await p1
    expect(fileContent.value?.content).toBe('new content')
  })

  it('searchFiles ignores stale responses', async () => {
    const first = deferred<FileSearchResult[]>()
    const second = deferred<FileSearchResult[]>()
    let call = 0
    api.searchFiles = (async () => (++call === 1 ? first.promise : second.promise)) as typeof api.searchFiles

    const { searchResults, searchFiles } = useFiles()
    const p1 = searchFiles('foo')
    const p2 = searchFiles('bar')

    second.resolve([{ path: 'b/bar.ts', name: 'bar.ts', type: 'file' }])
    await p2
    expect(searchResults.value.map(r => r.name)).toEqual(['bar.ts'])

    first.resolve([{ path: 'a/foo.ts', name: 'foo.ts', type: 'file' }])
    await p1
    expect(searchResults.value.map(r => r.name)).toEqual(['bar.ts'])
  })
})
