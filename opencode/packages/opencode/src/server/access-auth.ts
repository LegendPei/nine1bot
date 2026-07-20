export type ServerAccessAuthRequest = {
  remoteAddress?: string
  localBrowserRelay: boolean
}

export interface ServerAccessAuthProvider {
  // Keep the provider boundary structurally generic. Nine1Bot and the embedded
  // OpenCode workspace may resolve different Hono patch versions.
  handle(c: any, next: () => Promise<void>, request: ServerAccessAuthRequest): Promise<Response | void>
}

let provider: ServerAccessAuthProvider | undefined

export function setServerAccessAuthProvider(nextProvider: ServerAccessAuthProvider): void {
  provider = nextProvider
}

export function clearServerAccessAuthProvider(expected?: ServerAccessAuthProvider): void {
  if (!expected || provider === expected) {
    provider = undefined
  }
}

export function getServerAccessAuthProvider(): ServerAccessAuthProvider | undefined {
  return provider
}
