import { describe, expect, it, vi } from "vitest"

import { buildDesktopSettingsSnapshot } from "../../../shared/settings-types"
import { DesktopSettingsService } from "./settings-service"

describe("buildDesktopSettingsSnapshot", () => {
  it("defaults to practical work style", () => {
    expect(buildDesktopSettingsSnapshot({})).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
      agentEnvironment: "local",
      restartRequired: false,
    })
  })

  it("preserves an efficient work style", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "efficient" })).toEqual({
      workStyle: "efficient",
      notificationMode: "when_unfocused",
      agentEnvironment: "local",
      restartRequired: false,
    })
  })

  it("rejects unknown persisted values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({ workStyle: "chatty" })).toEqual({
      workStyle: "practical",
      notificationMode: "when_unfocused",
      agentEnvironment: "local",
      restartRequired: false,
    })
  })

  it("preserves a valid desktop notification mode", () => {
    expect(buildDesktopSettingsSnapshot({}, { notificationMode: "always" })).toMatchObject({
      notificationMode: "always",
    })
  })

  it("rejects unknown desktop notification values by falling back safely", () => {
    expect(buildDesktopSettingsSnapshot({}, { notificationMode: "chatty" })).toMatchObject({
      notificationMode: "when_unfocused",
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
      getPreferences: () => ({ notificationMode: "when_unfocused" }),
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
      getPreferences: () => ({ notificationMode: "when_unfocused" }),
      patchPreferences: vi.fn(),
    })

    await expect(service.updateAgentEnvironment({ environment: "docker" }))
      .rejects.toThrow("Docker daemon is not running")
    expect(patchSettings).not.toHaveBeenCalled()
  })
})
