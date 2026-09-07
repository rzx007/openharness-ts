import type { OpenHarnessClient } from "@openharness/client"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

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

const execFileAsync = promisify(execFile)
type SettingsClient = Pick<OpenHarnessClient, "getSettings" | "patchSettings">

export interface DesktopSettingsServiceDependencies {
  daemonClient(): Promise<SettingsClient>
  refreshDaemonClient(): Promise<SettingsClient>
  preflightDocker(): Promise<void>
  getPreferences: typeof getDesktopPreferences
  patchPreferences: typeof patchDesktopPreferences
}

const defaultDependencies: DesktopSettingsServiceDependencies = {
  daemonClient: () => desktopSessionService.daemonClient(),
  refreshDaemonClient: () => desktopSessionService.refreshDaemonClient(),
  preflightDocker: preflightDesktopDocker,
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
    if (input.environment !== "local" && input.environment !== "docker") {
      throw new Error("未知的智能体运行环境，请选择本机或 Docker 沙箱。")
    }
    if (input.environment === "docker") await this.dependencies.preflightDocker()
    return this.withDaemonRetry(async (client) => {
      const settings = await client.patchSettings({
        sandbox: {
          enabled: input.environment === "docker",
          backend: "docker",
          failIfUnavailable: true,
        },
      })
      return buildDesktopSettingsSnapshot(settings, this.dependencies.getPreferences(), {
        restartRequired: true,
      })
    })
  }

  private async snapshotWithPreferences(
    preferences: DesktopPreferences
  ): Promise<DesktopSettingsSnapshot> {
    try {
      return await this.withDaemonRetry(async (client) =>
        buildDesktopSettingsSnapshot(await client.getSettings(), preferences)
      )
    } catch {
      return buildDesktopSettingsSnapshot({}, preferences)
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

export async function preflightDesktopDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
      windowsHide: true,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Docker 不可用，请确认 Docker Desktop 已启动。${detail ? ` ${detail}` : ""}`)
  }
}
