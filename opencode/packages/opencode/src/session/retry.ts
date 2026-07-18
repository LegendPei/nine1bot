import type { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"

export namespace SessionRetry {
  export const RETRY_INITIAL_DELAY = 2000
  export const RETRY_BACKOFF_FACTOR = 2
  export const MAX_ATTEMPTS = 5
  export const MAX_DELAY_MS = 30_000
  export const RETRY_MAX_DELAY_NO_HEADERS = MAX_DELAY_MS
  export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

  export function canRetry(attempt: number) {
    return attempt < MAX_ATTEMPTS
  }

  export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      }
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", abortHandler)
          resolve()
        },
        Math.min(ms, RETRY_MAX_DELAY),
      )
      signal.addEventListener("abort", abortHandler, { once: true })
    })
  }

  export function delay(attempt: number, error?: MessageV2.APIError) {
    if (error) {
      const headers = error.data.responseHeaders
      if (headers) {
        const retryAfterMs = headers["retry-after-ms"]
        if (retryAfterMs) {
          const parsedMs = Number.parseFloat(retryAfterMs)
          if (!Number.isNaN(parsedMs) && parsedMs >= 0) {
            return Math.min(parsedMs, MAX_DELAY_MS)
          }
        }

        const retryAfter = headers["retry-after"]
        if (retryAfter) {
          const parsedSeconds = Number.parseFloat(retryAfter)
          if (!Number.isNaN(parsedSeconds) && parsedSeconds >= 0) {
            // convert seconds to milliseconds
            return Math.min(Math.ceil(parsedSeconds * 1000), MAX_DELAY_MS)
          }
          // Try parsing as HTTP date format
          const parsed = Date.parse(retryAfter) - Date.now()
          if (!Number.isNaN(parsed) && parsed > 0) {
            return Math.min(Math.ceil(parsed), MAX_DELAY_MS)
          }
        }

        return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), MAX_DELAY_MS)
      }
    }

    return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
  }

  export function retryable(error: ReturnType<NamedError["toObject"]>) {
    if (MessageV2.APIError.isInstance(error)) {
      if (!error.data.isRetryable) return undefined
      return error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message
    }

    const json = iife(() => {
      try {
        if (typeof error.data?.message === "string") {
          const parsed = JSON.parse(error.data.message)
          return parsed
        }

        return JSON.parse(error.data.message)
      } catch {
        return undefined
      }
    })

    // Fallback: detect network-related errors by message keywords
    const rawMsg = typeof error.data?.message === "string" ? error.data.message.toLowerCase() : ""
    if (rawMsg.includes("network") || rawMsg.includes("connection lost")
        || rawMsg.includes("etimedout") || rawMsg.includes("econnrefused")
        || rawMsg.includes("socket hang up")) {
      return "Network error"
    }

    if (!json || typeof json !== "object") return undefined
    const code = typeof json.code === "string" ? json.code : ""

    if (json.type === "error" && json.error?.type === "too_many_requests") {
      return "Too Many Requests"
    }
    if (code.includes("exhausted") || code.includes("unavailable")) {
      return "Provider is overloaded"
    }
    if (json.type === "error" && json.error?.code?.includes("rate_limit")) {
      return "Rate Limited"
    }
    if (
      json.error?.message?.includes("no_kv_space") ||
      (json.type === "error" && json.error?.type === "server_error") ||
      !!json.error
    ) {
      return "Provider Server Error"
    }
  }
}
