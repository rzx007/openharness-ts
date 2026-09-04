import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

import { createUpdaterService } from "./updater-service"

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

describe("updater service startup", () => {
  it("configures and checks once after a delay for packaged Windows and Linux apps", async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = createUpdaterService({
      updater,
      isPackaged: true,
      platform: "win32",
      checkDelayMs: 2_000,
      logger: { info: vi.fn(), error: vi.fn() },
      setForceQuit: vi.fn(),
    })

    service.startAfterWindowShown()

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()

    service.startAfterWindowShown()
    await vi.runAllTimersAsync()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    service.dispose()
    vi.useRealTimers()
  })

  it.each([
    ["development", false, "win32"],
    ["macOS", true, "darwin"],
  ])("does not initialize or check in %s", async (_label, isPackaged, platform) => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = createUpdaterService({
      updater,
      isPackaged,
      platform,
      checkDelayMs: 1,
      logger: { info: vi.fn(), error: vi.fn() },
      setForceQuit: vi.fn(),
    })

    service.startAfterWindowShown()
    await vi.runAllTimersAsync()

    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    service.dispose()
    vi.useRealTimers()
  })
})

describe("updater service state and commands", () => {
  it("publishes available, download progress, and downloaded states", async () => {
    const updater = new FakeUpdater()
    const service = createService(updater)
    const states: unknown[] = []
    service.subscribe((state) => states.push(state))

    updater.emit("checking-for-update")
    updater.emit("update-available", { version: "1.2.0" })
    await service.download()
    updater.emit("download-progress", {
      percent: 42.25,
      transferred: 4_225,
      total: 10_000,
      bytesPerSecond: 900,
    })
    updater.emit("update-downloaded", { version: "1.2.0" })

    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(states).toEqual([
      { status: "checking" },
      { status: "available", version: "1.2.0" },
      {
        status: "downloading",
        version: "1.2.0",
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
      {
        status: "downloading",
        version: "1.2.0",
        percent: 42.25,
        transferred: 4_225,
        total: 10_000,
        bytesPerSecond: 900,
      },
      { status: "downloaded", version: "1.2.0" },
    ])
    expect(service.getState()).toEqual({ status: "downloaded", version: "1.2.0" })
    service.dispose()
  })

  it("returns a background check failure to idle without publishing an error", async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error("offline"))
    const logger = { info: vi.fn(), error: vi.fn() }
    const service = createService(updater, logger)
    const states: unknown[] = []
    service.subscribe((state) => states.push(state))

    service.startAfterWindowShown()
    await vi.runAllTimersAsync()

    expect(service.getState()).toEqual({ status: "idle" })
    expect(states).not.toContainEqual(expect.objectContaining({ status: "error" }))
    expect(logger.error).toHaveBeenCalled()
    service.dispose()
    vi.useRealTimers()
  })

  it("publishes a user-visible error when a requested download fails", async () => {
    const updater = new FakeUpdater()
    updater.downloadUpdate.mockRejectedValueOnce(new Error("disk full"))
    const service = createService(updater)
    updater.emit("update-available", { version: "2.0.0" })

    await expect(service.download()).rejects.toThrow("disk full")

    expect(service.getState()).toEqual({
      status: "error",
      version: "2.0.0",
      message: "disk full",
    })
    service.dispose()
  })

  it("forces quit before installing a downloaded update", () => {
    const updater = new FakeUpdater()
    const setForceQuit = vi.fn()
    const service = createService(updater, undefined, setForceQuit)
    updater.emit("update-downloaded", { version: "3.0.0" })

    service.install()

    expect(setForceQuit).toHaveBeenCalledWith(true)
    expect(setForceQuit.mock.invocationCallOrder[0]).toBeLessThan(
      updater.quitAndInstall.mock.invocationCallOrder[0]
    )
    service.dispose()
  })

  it("cancels the timer and removes updater listeners when disposed", async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = createService(updater)
    const listener = vi.fn()
    service.subscribe(listener)
    service.startAfterWindowShown()

    service.dispose()
    updater.emit("update-available", { version: "9.0.0" })
    await vi.runAllTimersAsync()

    expect(listener).not.toHaveBeenCalled()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.listenerCount("update-available")).toBe(0)
    vi.useRealTimers()
  })
})

function createService(
  updater: FakeUpdater,
  logger = { info: vi.fn(), error: vi.fn() },
  setForceQuit = vi.fn()
) {
  return createUpdaterService({
    updater,
    isPackaged: true,
    platform: "win32",
    checkDelayMs: 1_000,
    logger,
    setForceQuit,
  })
}
