import { resolve } from "node:path"

import type { PluginInfo } from "@openharness/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const daemon = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  reloadPlugins: vi.fn(),
}))

vi.mock("../session/session-service", () => ({
  desktopSessionService: {
    daemonClient: vi.fn(async () => daemon),
    refreshDaemonClient: vi.fn(async () => daemon),
  },
}))

import { DesktopPluginService } from "./plugin-service"

const examplePlugin: PluginInfo = {
  identity: { id: "context7", name: "context7", displayName: "Context7", version: "1.0.0" },
  origin: "converted",
  sourceFormat: "claude-code",
  scope: "user",
  enabled: true,
  installation: "installed",
  activation: "active",
  inventory: { tools: 2 },
  permissions: { requested: ["network"], approved: ["network"], missing: [] },
  diagnostics: [],
}

describe("DesktopPluginService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    daemon.listPlugins.mockResolvedValue({ plugins: [examplePlugin], warnings: [] })
    daemon.enablePlugin.mockResolvedValue({ message: "enabled" })
    daemon.disablePlugin.mockResolvedValue({ message: "disabled" })
    daemon.uninstallPlugin.mockResolvedValue({ message: "uninstalled" })
    daemon.reloadPlugins.mockResolvedValue({
      plugins: [examplePlugin],
      warnings: ["cache rebuilt"],
      message: "reloaded",
    })
  })

  it("normalizes cwd and returns the installed plugin snapshot", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.snapshot({ cwd: "C:/workspace/project" })

    expect(snapshot).toEqual({
      cwd: resolve("C:/workspace/project"),
      plugins: [examplePlugin],
      warnings: [],
    })
    expect(daemon.listPlugins).toHaveBeenCalledWith({ cwd: resolve("C:/workspace/project") })
  })

  it("mutates a plugin and refreshes the snapshot", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.disable({ cwd: "C:/workspace/project", pluginId: " context7 " })

    expect(daemon.disablePlugin).toHaveBeenCalledWith("context7", {
      cwd: resolve("C:/workspace/project"),
    })
    expect(daemon.listPlugins).toHaveBeenCalledOnce()
    expect(snapshot.plugins).toEqual([examplePlugin])
  })

  it("uses the reload response without issuing a second list request", async () => {
    const service = new DesktopPluginService()
    const snapshot = await service.reload({ cwd: "C:/workspace/project" })

    expect(snapshot.warnings).toEqual(["cache rebuilt"])
    expect(daemon.reloadPlugins).toHaveBeenCalledWith({ cwd: resolve("C:/workspace/project") })
    expect(daemon.listPlugins).not.toHaveBeenCalled()
  })
})
