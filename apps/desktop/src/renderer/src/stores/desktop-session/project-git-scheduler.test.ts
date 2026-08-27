import { afterEach, describe, expect, it, vi } from "vitest"

import { createSelectedProjectGitRefreshScheduler } from "./project-git-scheduler"

describe("selected project Git refresh scheduler", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("debounces refreshes and forwards a requested force refresh", async () => {
    vi.useFakeTimers()
    const refresh = vi.fn<(options: { force: boolean }) => Promise<void>>(async () => undefined)
    const scheduler = createSelectedProjectGitRefreshScheduler(refresh, 750)

    scheduler.schedule(false)
    scheduler.schedule(true)
    await vi.advanceTimersByTimeAsync(749)

    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ force: true })
  })

  it("lets reset cancel pending work and dispose prevent later refreshes", async () => {
    vi.useFakeTimers()
    const refresh = vi.fn<(options: { force: boolean }) => Promise<void>>(async () => undefined)
    const scheduler = createSelectedProjectGitRefreshScheduler(refresh, 750)

    scheduler.schedule(true)
    scheduler.reset()
    await vi.advanceTimersByTimeAsync(750)
    expect(refresh).not.toHaveBeenCalled()

    scheduler.schedule(false)
    await vi.advanceTimersByTimeAsync(750)
    expect(refresh).toHaveBeenCalledWith({ force: false })

    scheduler.dispose()
    scheduler.schedule(true)
    await vi.advanceTimersByTimeAsync(750)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
