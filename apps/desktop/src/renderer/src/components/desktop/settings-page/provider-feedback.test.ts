import { afterEach, describe, expect, it, vi } from "vitest"

import { scheduleProviderNoticeDismissal } from "./provider-feedback"

describe("scheduleProviderNoticeDismissal", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("clears provider feedback only after the requested delay", () => {
    vi.useFakeTimers()
    const clear = vi.fn()

    scheduleProviderNoticeDismissal(clear, 4_000)
    vi.advanceTimersByTime(3_999)
    expect(clear).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(clear).toHaveBeenCalledOnce()
  })

  it("cancels a pending dismissal when the notice changes", () => {
    vi.useFakeTimers()
    const clear = vi.fn()

    const cancel = scheduleProviderNoticeDismissal(clear, 6_000)
    cancel()
    vi.advanceTimersByTime(6_000)

    expect(clear).not.toHaveBeenCalled()
  })

  it("supports the longer error-notice dismissal delay", () => {
    vi.useFakeTimers()
    const clear = vi.fn()

    scheduleProviderNoticeDismissal(clear, 6_000)
    vi.advanceTimersByTime(5_999)
    expect(clear).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(clear).toHaveBeenCalledOnce()
  })
})
