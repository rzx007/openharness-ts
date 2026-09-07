import { describe, expect, it, vi } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"
import { DesktopSettingsService } from "./settings-service"

const defaultSnapshot = {
  workStyle: "practical",
  notificationMode: "when_unfocused",
  agentEnvironment: "local",
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

  it("reports Docker and unsupported SRT settings explicitly", () => {
    expect(buildDesktopSettingsSnapshot({
      sandbox: { enabled: true, backend: "docker" },
    })).toMatchObject({ agentEnvironment: "docker" })
    expect(buildDesktopSettingsSnapshot({
      sandbox: { enabled: true, backend: "srt" },
    })).toMatchObject({ agentEnvironment: "unsupported_srt" })
  })
})

describe("DesktopSettingsService.updateAgentEnvironment", () => {
  it("preflights Docker before saving fail-closed settings", async () => {
    const calls: string[] = []
    const patchSettings = vi.fn(async (patch) => {
      calls.push("patch")
      return patch
    })
    const service = new DesktopSettingsService({
      daemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      refreshDaemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      preflightDocker: async () => { calls.push("preflight") },
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    const result = await service.updateAgentEnvironment({ environment: "docker" })

    expect(calls).toEqual(["preflight", "patch"])
    expect(patchSettings).toHaveBeenCalledWith({
      sandbox: { enabled: true, backend: "docker", failIfUnavailable: true },
    })
    expect(result).toMatchObject({ agentEnvironment: "docker", restartRequired: true })
  })

  it("does not save settings when Docker preflight fails", async () => {
    const patchSettings = vi.fn()
    const service = new DesktopSettingsService({
      daemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      refreshDaemonClient: async () => ({ getSettings: vi.fn(), patchSettings }) as any,
      preflightDocker: async () => { throw new Error("Docker daemon is not running") },
      getPreferences: preferences,
      patchPreferences: vi.fn(),
    })

    await expect(service.updateAgentEnvironment({ environment: "docker" }))
      .rejects.toThrow("Docker daemon is not running")
    expect(patchSettings).not.toHaveBeenCalled()
  })
})
