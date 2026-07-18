export namespace ProgressWatchdog {
  export const PROVIDER_INACTIVITY_TIMEOUT_MS = 5 * 60_000
  export type Info = ReturnType<typeof create>

  export function create(input: {
    timeoutMs?: number
    onTimeout: () => void
  }) {
    const enabled = input.timeoutMs !== undefined && input.timeoutMs > 0
    let active = enabled
    let timer: ReturnType<typeof setTimeout> | undefined

    const arm = () => {
      if (!active || !enabled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!active) return
        active = false
        input.onTimeout()
      }, input.timeoutMs)
    }

    arm()

    return {
      touch() {
        arm()
      },
      stop() {
        active = false
        if (timer) clearTimeout(timer)
        timer = undefined
      },
    }
  }
}
