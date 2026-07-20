let accessToken = ''
let unauthorizedHandler: (() => void) | undefined
let installed = false

function requestUrl(input: RequestInfo | URL): URL | undefined {
  try {
    const value = input instanceof Request ? input.url : input.toString()
    return new URL(value, window.location.href)
  } catch {
    return undefined
  }
}

export function setAccessToken(token: string | undefined): void {
  accessToken = token?.trim() || ''
}

export function getAccessToken(): string {
  return accessToken
}

export function setAccessUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler
}

export function installAccessFetchInterceptor(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input)
    const sameOrigin = url?.origin === window.location.origin
    let preparedInit = init

    if (sameOrigin && accessToken) {
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init.headers).forEach((value, key) => headers.set(key, value))
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${accessToken}`)
      }
      preparedInit = { ...init, headers }
    }

    const response = await originalFetch(input, preparedInit)
    if (
      sameOrigin &&
      response.status === 401 &&
      !url?.pathname.startsWith('/access-auth/')
    ) {
      unauthorizedHandler?.()
    }
    return response
  }
}
