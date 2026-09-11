import { dirname } from "node:path"

import { loadSettings, saveSettings } from "@openharness/core"
import { DaemonSystemService, type DaemonSystemServiceState } from "@openharness/server"
import { app } from "electron"

import type { DesktopDaemonAutoStartSnapshot } from "@shared/settings-types"
import {
  getDesktopPreferences,
  initializeDesktopInstallIdentity,
  patchDesktopPreferences,
} from "../settings/desktop-preferences"

type SystemService = Pick<DaemonSystemService, "status" | "install" | "uninstall" | "start">

export interface DaemonAutoStartDependencies {
  loadSettings: typeof loadSettings
  saveSettings: typeof saveSettings
  preferences: typeof getDesktopPreferences
  initializeIdentity: typeof initializeDesktopInstallIdentity
  patchPreferences: typeof patchDesktopPreferences
  systemService: () => SystemService
}

const defaultDependencies: DaemonAutoStartDependencies = {
  loadSettings,
  saveSettings,
  preferences: getDesktopPreferences,
  initializeIdentity: initializeDesktopInstallIdentity,
  patchPreferences: patchDesktopPreferences,
  systemService: createDesktopDaemonSystemService,
}

export class DaemonAutoStartService {
  constructor(private readonly dependencies: DaemonAutoStartDependencies = defaultDependencies) {}

  async snapshot(): Promise<DesktopDaemonAutoStartSnapshot> {
    const preferences = this.dependencies.initializeIdentity()
    const configured = (await this.dependencies.loadSettings()).daemon?.autoStart ?? false
    const serviceState = this.dependencies.systemService().status().state
    const enabled = configured && serviceState !== "not-installed"
    const onboardingState = preferences.daemonOnboardingState ?? "dismissed"
    if (configured && onboardingState === "pending") {
      this.dependencies.patchPreferences({ daemonOnboardingState: "enabled" })
      return {
        configured,
        serviceState,
        enabled,
        onboardingState: "enabled",
        showOnboarding: false,
      }
    }
    return {
      configured,
      serviceState,
      enabled,
      onboardingState,
      showOnboarding: onboardingState === "pending" && !configured,
    }
  }

  async enable(): Promise<DesktopDaemonAutoStartSnapshot> {
    const previous = await this.dependencies.loadSettings()
    await this.dependencies.saveSettings({
      ...previous,
      daemon: { ...previous.daemon, autoStart: true },
    })
    try {
      const service = this.dependencies.systemService()
      const state = service.status().state
      if (state === "not-installed") service.install()
      else if (state === "stopped") service.start()
      const verified = service.status().state
      if (verified === "not-installed" || verified === "stopped") {
        throw new Error("daemon 系统服务未能启动。")
      }
      this.dependencies.patchPreferences({ daemonOnboardingState: "enabled" })
      return await this.snapshot()
    } catch (error) {
      await this.dependencies.saveSettings(previous)
      throw error
    }
  }

  async disable(): Promise<DesktopDaemonAutoStartSnapshot> {
    const service = this.dependencies.systemService()
    service.uninstall()
    const settings = await this.dependencies.loadSettings()
    await this.dependencies.saveSettings({
      ...settings,
      daemon: { ...settings.daemon, autoStart: false },
    })
    return await this.snapshot()
  }

  async dismissOnboarding(): Promise<DesktopDaemonAutoStartSnapshot> {
    const preferences = this.dependencies.preferences()
    if (preferences.daemonOnboardingState === "pending") {
      this.dependencies.patchPreferences({ daemonOnboardingState: "dismissed" })
    }
    return await this.snapshot()
  }
}

export function createDesktopDaemonSystemService(): DaemonSystemService {
  const flag = process.platform === "win32" ? "--daemon-watchdog" : "--daemon-service"
  const args = app.isPackaged ? [flag] : [app.getAppPath(), flag]
  return new DaemonSystemService({
    invocation: {
      command: process.execPath,
      args,
      cwd: dirname(process.execPath),
    },
  })
}

export function isDaemonServiceEnabled(
  configured: boolean,
  serviceState: DaemonSystemServiceState
): boolean {
  return configured && serviceState !== "not-installed"
}

export const daemonAutoStartService = new DaemonAutoStartService()
