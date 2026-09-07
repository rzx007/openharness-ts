import { describe, expect, it, vi } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"
import { DesktopSettingsService } from "./settings-service"

const defaultSnapshot = {
  workStyle: "practical",
  notificationMode: "when_unfocused",
  agentEnvironment: "native",
  wslSupported: false,
  restartRequired: false,
  defaultOpenerId: null,
  defaultTerminalShellId: null,
} as const

const preferences = () => ({
  notificationMode: "when_unfocused" as const,
})

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults safely", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual(defaultSnapshot)
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      ...defaultSnapshot,
      workStyle: "efficient",
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual(defaultSnapshot)
  })

  it("preserves valid notification and desktop preference values", () => {
    expect(buildDesktopSettingsSnapshot({}, {
      notificationMode: "always",
      defaultOpenerId: "  vscode  ",
      defaultTerminalShellId: "  pwsh  ",
    })).toMatchObject({
      notificationMode: "always",
      defaultOpenerId: "vscode",
      defaultTerminalShellId: "pwsh",
    })
  })

  it("normalizes unknown or blank preference values", () => {
    expect(buildDesktopSettingsSnapshot({}, {
      notificationMode: "chatty",
      defaultOpenerId: "   ",
      defaultTerminalShellId: "system",
    })).toMatchObject({
      notificationMode: "when_unfocused",
      defaultOpenerId: null,
      defaultTerminalShellId: null,
    })
  })

  it("uses only the explicit agent environment setting", () => {
    expect(buildDesktopSettingsSnapshot({
      agentEnvironment: { kind: "wsl" },
      sandbox: { enabled: true, backend: "docker" },
    })).toMatchObject({ agentEnvironment: "wsl" })
    expect(buildDesktopSettingsSnapshot({
      sandbox: { enabled: true, backend: "docker" },
    })).toMatchObject({ agentEnvironment: "native" })
  })
})

describe("DesktopSettingsService.updateAgentEnvironment", () => {
  it("preflights WSL before saving the global environment", async () => {
    const calls: string[] = []
    const patchSettings = vi.fn(async (patch) => {
      calls.push("patch")
      return patch
    })
    const service = new DesktopSettingsService({
      daemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      refreshDaemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      preflightWsl: async () => { calls.push("preflight") },
      platform: "win32",
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    const result = await service.updateAgentEnvironment({ environment: "wsl" })

    expect(calls).toEqual(["preflight", "patch"])
    expect(patchSettings).toHaveBeenCalledWith({
      agentEnvironment: { kind: "wsl" },
    })
    expect(result).toMatchObject({ agentEnvironment: "wsl", restartRequired: true, wslSupported: true })
  })

  it("does not save settings when WSL preflight fails", async () => {
    const patchSettings = vi.fn()
    const service = new DesktopSettingsService({
      daemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      refreshDaemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      preflightWsl: async () => { throw new Error("WSL is not installed") },
      platform: "win32",
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    await expect(service.updateAgentEnvironment({ environment: "wsl" }))
      .rejects.toThrow("WSL is not installed")
    expect(patchSettings).not.toHaveBeenCalled()
  })
})
