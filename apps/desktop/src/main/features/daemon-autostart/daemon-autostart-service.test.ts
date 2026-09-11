import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => "D:/app", getPath: () => "D:/data" },
}))

import { DaemonAutoStartService } from "./daemon-autostart-service"

function fixture(
  options: { configured?: boolean; state?: "not-installed" | "stopped" | "running" } = {}
) {
  let settings = { daemon: { autoStart: options.configured ?? false } }
  let preferences: {
    notificationMode: "when_unfocused"
    installIdentity: "new"
    daemonOnboardingState: "pending" | "enabled" | "dismissed"
  } = {
    notificationMode: "when_unfocused" as const,
    installIdentity: "new" as const,
    daemonOnboardingState: "pending",
  }
  let state = options.state ?? "not-installed"
  const install = vi.fn(() => {
    state = "running"
  })
  const uninstall = vi.fn(() => {
    state = "not-installed"
  })
  const start = vi.fn(() => {
    state = "running"
  })
  const service = new DaemonAutoStartService({
    loadSettings: vi.fn(async () => settings) as never,
    saveSettings: vi.fn(async (next) => {
      settings = next as typeof settings
    }) as never,
    preferences: vi.fn(() => preferences),
    initializeIdentity: vi.fn(() => preferences),
    patchPreferences: vi.fn((patch) => {
      preferences = { ...preferences, ...patch }
      return preferences
    }),
    systemService: () => ({
      status: () => ({ platform: "win32", state }),
      install,
      uninstall,
      start,
    }),
  })
  return {
    service,
    install,
    uninstall,
    start,
    settings: () => settings,
    preferences: () => preferences,
  }
}

describe("DaemonAutoStartService", () => {
  it("shows onboarding only for a pending new install with autostart disabled", async () => {
    const { service } = fixture()
    expect(await service.snapshot()).toMatchObject({ enabled: false, showOnboarding: true })
  })

  it("installs the service and completes onboarding", async () => {
    const { service, install, settings, preferences } = fixture()
    expect(await service.enable()).toMatchObject({ enabled: true, showOnboarding: false })
    expect(install).toHaveBeenCalledOnce()
    expect(settings().daemon.autoStart).toBe(true)
    expect(preferences().daemonOnboardingState).toBe("enabled")
  })

  it("uninstalls without resetting completed onboarding", async () => {
    const value = fixture({ configured: true, state: "running" })
    await value.service.enable()
    await value.service.disable()
    expect(value.uninstall).toHaveBeenCalledOnce()
    expect(value.settings().daemon.autoStart).toBe(false)
    expect(value.preferences().daemonOnboardingState).toBe("enabled")
  })

  it("dismisses onboarding permanently", async () => {
    const { service, preferences } = fixture()
    expect(await service.dismissOnboarding()).toMatchObject({ showOnboarding: false })
    expect(preferences().daemonOnboardingState).toBe("dismissed")
  })
})
