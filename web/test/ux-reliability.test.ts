import { afterEach, describe, expect, it } from 'bun:test'
import { api, configApi, customProviderApi, nine1botConfigApi, permissionApi, platformApi, questionApi, setApiDirectory, type Session } from '../src/api/client'
import { useSession } from '../src/composables/useSession'
import { useSettings } from '../src/composables/useSettings'
import { useFiles } from '../src/composables/useFiles'

const originals = [api, configApi, customProviderApi, nine1botConfigApi, permissionApi, platformApi, questionApi].map(object => [object, { ...object }] as const)
const originalFetch = globalThis.fetch
let current: ReturnType<typeof useSession> | undefined
afterEach(() => {
  current?.unsubscribe()
  current = undefined
  for (const [object, methods] of originals) Object.assign(object, methods)
  globalThis.fetch = originalFetch
  setApiDirectory('')
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const session = (id: string): Session => ({ id, title: id, directory: `/workspace/${id}`, time: { created: 1, updated: 1 } })
function setupSession() {
  api.subscribeSessionRuntimeEvents = () => ({ ready: Promise.resolve(), close() {}, connectionGeneration: () => 1 })
  api.getMessages = async () => []
  api.getSessions = async () => []
  api.getSessionStatus = async () => ({})
  permissionApi.list = async () => []
  questionApi.list = async () => []
  current = useSession()
  return current
}

describe('chat and settings reliability', () => {
  it('never sends a pending draft to the session selected while creation was in flight', async () => {
    const state = setupSession()
    const created = deferred<Session>()
    api.createSession = () => created.promise
    let sends = 0
    api.sendMessage = async () => { sends++; return { accepted: true, sessionId: 'wrong' } }
    state.createSession('/workspace/A')
    const sending = state.sendMessage('for A')
    await new Promise(resolve => setTimeout(resolve, 0))
    await state.selectSession(session('B'))
    created.resolve(session('A'))
    expect(await sending).toBe(false)
    expect(sends).toBe(0)
    expect(state.currentSession.value?.id).toBe('B')
  })

  it('shares an in-flight session creation between upload and send', async () => {
    const state = setupSession()
    const created = deferred<Session>()
    let creates = 0
    api.createSession = () => { creates++; return created.promise }
    state.createSession('/workspace/A')
    const first = state.ensureSession()
    const second = state.ensureSession()
    created.resolve(session('A'))
    expect((await first)?.id).toBe('A')
    expect((await second)?.id).toBe('A')
    expect(creates).toBe(1)
  })

  it('shows history before a slow auxiliary request and keeps it when that request fails', async () => {
    const state = setupSession()
    const permissions = deferred<any>()
    permissionApi.list = () => permissions.promise.then(() => { throw new Error('offline') })
    api.getMessages = async () => [{ info: { id: 'm', role: 'user', sessionID: 'A', time: { created: 1 } }, parts: [] }]
    const loading = state.selectSession(session('A'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.messages.value).toHaveLength(1)
    expect(state.isLoading.value).toBe(false)
    permissions.resolve(null)
    await loading
    expect(state.messages.value).toHaveLength(1)
    expect(state.historyError.value).toContain('权限请求')
  })

  it('rejects HTTP failures instead of returning empty history or confirming a saved model', async () => {
    globalThis.fetch = async () => Response.json({ error: 'service unavailable' }, { status: 503 })
    await expect(api.getMessages('A')).rejects.toThrow('service unavailable')
    await expect(configApi.update({ model: 'p/a' })).rejects.toThrow('service unavailable')
    const settings = useSettings()
    settings.defaultModel.value = 'previous'
    expect(await settings.setDefaultModel('p', 'new')).toBe(false)
    expect(settings.defaultModel.value).toBe('previous')
    expect(settings.settingsError.value).toBe('service unavailable')
  })

  it('loads custom providers without writing configuration', async () => {
    customProviderApi.list = async () => ({})
    let writes = 0
    nine1botConfigApi.update = async () => { writes++ }
    await useSettings().loadCustomProviders()
    expect(writes).toBe(0)
  })

  it('ignores a previous platform response after another platform was selected', async () => {
    const older = deferred<any>()
    platformApi.get = id => id === 'A' ? older.promise : Promise.resolve({ id: 'B' } as any)
    const settings = useSettings()
    const first = settings.loadPlatformDetail('A')
    await settings.loadPlatformDetail('B')
    older.resolve({ id: 'A' })
    await first
    expect(settings.selectedPlatformId.value).toBe('B')
    expect(settings.selectedPlatform.value?.id).toBe('B')
  })

  it('serializes model writes so the last choice is also the last server write', async () => {
    const firstWrite = deferred<any>()
    const writes: string[] = []
    configApi.update = async config => { writes.push(config.model!); if (config.model === 'p/A') await firstWrite.promise; return config }
    const settings = useSettings()
    const first = settings.selectModel('p', 'A')
    const second = settings.selectModel('p', 'B')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual(['p/A'])
    firstWrite.resolve({})
    await Promise.all([first, second])
    expect(writes).toEqual(['p/A', 'p/B'])
    expect(settings.currentModel.value).toBe('B')
  })

  it('invalidates pending file and search responses when cleared', async () => {
    const files = useFiles()
    const search = deferred<any>()
    const content = deferred<any>()
    api.searchFiles = () => search.promise
    api.getFileContent = () => content.promise
    const searching = files.searchFiles('old')
    const loading = files.loadFileContent('old')
    files.clearSearch()
    files.clearFileContent()
    search.resolve([{ path: 'old' }])
    content.resolve({ content: 'old' })
    await Promise.all([searching, loading])
    expect(files.searchResults.value).toEqual([])
    expect(files.fileContent.value).toBeNull()
    expect(files.isSearching.value).toBe(false)
    expect(files.isLoadingContent.value).toBe(false)
  })
})
