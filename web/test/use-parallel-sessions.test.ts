import { describe, expect, it } from 'bun:test'
import { useParallelSessions } from '../src/composables/useParallelSessions'

describe('useParallelSessions running state cleanup', () => {
  it('deletes the entry when a session is set to not running', () => {
    const { setSessionRunning, isSessionRunning, runningStates } = useParallelSessions()
    const id = `session-${Math.random().toString(36).slice(2, 10)}`

    setSessionRunning(id, true)
    expect(isSessionRunning(id)).toBe(true)
    expect(id in runningStates).toBe(true)

    setSessionRunning(id, false)
    expect(isSessionRunning(id)).toBe(false)
    expect(id in runningStates).toBe(false)
  })

  it('does not count removed entries in runningCount', () => {
    const { setSessionRunning, runningCount } = useParallelSessions()
    const id = `session-${Math.random().toString(36).slice(2, 10)}`

    const baseline = runningCount.value
    setSessionRunning(id, true)
    expect(runningCount.value).toBe(baseline + 1)

    setSessionRunning(id, false)
    expect(runningCount.value).toBe(baseline)
  })
})
