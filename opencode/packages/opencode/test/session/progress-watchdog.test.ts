import { describe, expect, test } from "bun:test"
import { ProgressWatchdog } from "../../src/session/progress-watchdog"

describe("ProgressWatchdog", () => {
  test("fires after the configured inactivity window", async () => {
    const fired: string[] = []
    const watchdog = ProgressWatchdog.create({
      timeoutMs: 20,
      onTimeout: () => fired.push("timeout"),
    })

    await Bun.sleep(30)
    expect(fired).toEqual(["timeout"])
    watchdog.stop()
  })

  test("touch resets the inactivity window", async () => {
    const fired: string[] = []
    const watchdog = ProgressWatchdog.create({
      timeoutMs: 100,
      onTimeout: () => fired.push("timeout"),
    })

    await Bun.sleep(10)
    watchdog.touch()
    await Bun.sleep(40)
    expect(fired).toEqual([])
    await Bun.sleep(80)
    expect(fired).toEqual(["timeout"])
    watchdog.stop()
  })

  test("stop prevents the timeout", async () => {
    const fired: string[] = []
    const watchdog = ProgressWatchdog.create({
      timeoutMs: 20,
      onTimeout: () => fired.push("timeout"),
    })

    watchdog.stop()
    await Bun.sleep(30)
    expect(fired).toEqual([])
  })

  test("stays disabled when no positive timeout is configured", async () => {
    const fired: string[] = []
    const disabled = [undefined, 0].map((timeoutMs) =>
      ProgressWatchdog.create({
        timeoutMs,
        onTimeout: () => fired.push("timeout"),
      }),
    )

    await Bun.sleep(30)
    expect(fired).toEqual([])
    disabled.forEach((watchdog) => watchdog.stop())
  })
})
