import type { OpenHarnessClient } from "@openharness/client"
import { preflightWsl } from "@openharness/sandbox"

import {
  buildDesktopSettingsSnapshot,
  isDesktopNotificationMode,
  isDesktopWorkStyle,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
} from "../../../shared/settings-types"
import type {
  DesktopSettingsSnapshot,
  UpdateDesktopAgentEnvironmentInput,
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import { desktopSessionService } from "../session/session-service"
import {
  getDesktopPreferences,
  patchDesktopPreferences,
  type DesktopPreferences,
} from "./desktop-preferences"

type SettingsClient = Pick<OpenHarnessClient, "getSettings" | "patchSettings">

export interface DesktopSettingsServiceDependencies {
  daemonClient(): Promise<SettingsClient>
  refreshDaemonClient(): Promise<SettingsClient>
  preflightWsl(): Promise<void>
  platform: NodeJS.Platform
  getPreferences: typeof getDesktopPreferences
  patchPreferences: typeof patchDesktopPreferences
}

const defaultDependencies: DesktopSettingsServiceDependencies = {
  daemonClient: () => desktopSessionService.daemonClient(),
  refreshDaemonClient: () => desktopSessionService.refreshDaemonClient(),
  preflightWsl,
  platform: process.platform,
  getPreferences: getDesktopPreferences,
  patchPreferences: patchDesktopPreferences,
}

export class DesktopSettingsService {
  constructor(private readonly dependencies: DesktopSettingsServiceDependencies = defaultDependencies) {}

  snapshot(): Promise<DesktopSettingsSnapshot> {
    return this.snapshotWithPreferences(this.dependencies.getPreferences())
  }

  async updateWorkStyle(input: UpdateDesktopWorkStyleInput): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopWorkStyle(input.workStyle)) {
      throw new Error("未知的工作风格，请选择务实或高效。")
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.patchSettings({ workStyle: input.workStyle })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences())
    })
  }

  async updateNotificationMode(
    input: UpdateDesktopNotificationModeInput
  ): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopNotificationMode(input.notificationMode)) {
      throw new Error("未知的通知设置，请选择从不、仅失去焦点时或始终。")
    }
    const preferences = this.dependencies.patchPreferences({
      notificationMode: input.notificationMode,
    })
    return this.snapshotWithPreferences(preferences)
  }

  async updateDefaultOpener(
    input: UpdateDesktopDefaultOpenerInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultOpenerId = normalizeDefaultOpenerId(input.defaultOpenerId)
    if (!defaultOpenerId) throw new Error("打开方式不能为空。")
    const preferences = this.dependencies.patchPreferences({ defaultOpenerId })
    return this.snapshotWithPreferences(preferences)
  }

  async updateDefaultTerminalShell(
    input: UpdateDesktopDefaultTerminalShellInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultTerminalShellId = normalizeDefaultTerminalShellId(input.defaultTerminalShellId)
    const preferences = this.dependencies.patchPreferences({ defaultTerminalShellId })
    return this.snapshotWithPreferences(preferences)
  }

  async updateAgentEnvironment(
    input: UpdateDesktopAgentEnvironmentInput
  ): Promise<DesktopSettingsSnapshot> {
    if (input.environment !== "native" && input.environment !== "wsl") {
      throw new Error("未知的智能体运行环境，请选择本机或 WSL。")
    }
    if (input.environment === "wsl") {
      if (this.dependencies.platform !== "win32") throw new Error("WSL 仅可在 Windows 上使用。")
      await this.dependencies.preflightWsl()
    }
    return this.withDaemonRetry(async (client) => {
      const settings = await client.patchSettings({
        agentEnvironment: { kind: input.environment },
      })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences(), {
        restartRequired: true,
        wslSupported: this.dependencies.platform === "win32",
      })
    })
  }

  private async snapshotWithPreferences(
    preferences: DesktopPreferences
  ): Promise<DesktopSettingsSnapshot> {
    try {
      return await this.withDaemonRetry(async (client) =>
        buildDesktopSettingsSnapshot(await client.getSettings(), preferences, {
          wslSupported: this.dependencies.platform === "win32",
        })
      )
    } catch {
      return buildDesktopSettingsSnapshot({}, preferences, {
        wslSupported: this.dependencies.platform === "win32",
      })
    }
  }

  private async withDaemonRetry<T>(operation: (client: SettingsClient) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.dependencies.daemonClient())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.includes("Failed to fetch") &&
        !message.includes("ECONNREFUSED") &&
        !message.includes("ECONNRESET")
      ) {
        throw error
      }
      return await operation(await this.dependencies.refreshDaemonClient())
    }
  }
}

export const desktopSettingsService = new DesktopSettingsService()

