import type { OpenHarnessClient } from "@openharness/client"

import {
  buildDesktopSettingsSnapshot,
  isDesktopNotificationMode,
  isDesktopWorkStyle,
  normalizeDefaultOpenerId,
  normalizeDefaultTerminalShellId,
} from "../../../shared/settings-types"
import type {
  UpdateDesktopDefaultOpenerInput,
  UpdateDesktopDefaultTerminalShellInput,
  UpdateDesktopNotificationModeInput,
  DesktopSettingsSnapshot,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import type { DesktopPreferences } from "./desktop-preferences"
import { desktopSessionService } from "../session/session-service"
import { getDesktopPreferences, patchDesktopPreferences } from "./desktop-preferences"

export class DesktopSettingsService {
  snapshot(): Promise<DesktopSettingsSnapshot> {
    return snapshotWithPreferences(getDesktopPreferences())
  }

  async updateWorkStyle(input: UpdateDesktopWorkStyleInput): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopWorkStyle(input.workStyle)) {
      throw new Error("未知的工作风格，请选择务实或高效。")
    }
    return withDaemonRetry(async (client) => {
      const settings = await client.patchSettings({ workStyle: input.workStyle })
      return buildDesktopSettingsSnapshot(settings, getDesktopPreferences())
    })
  }

  async updateNotificationMode(
    input: UpdateDesktopNotificationModeInput
  ): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopNotificationMode(input.notificationMode)) {
      throw new Error("未知的通知设置，请选择从不、仅失去焦点时或始终。")
    }
    const preferences = patchDesktopPreferences({ notificationMode: input.notificationMode })
    return snapshotWithPreferences(preferences)
  }

  async updateDefaultOpener(
    input: UpdateDesktopDefaultOpenerInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultOpenerId = normalizeDefaultOpenerId(input.defaultOpenerId)
    if (!defaultOpenerId) {
      throw new Error("打开方式不能为空。")
    }
    const preferences = patchDesktopPreferences({ defaultOpenerId })
    return snapshotWithPreferences(preferences)
  }

  async updateDefaultTerminalShell(
    input: UpdateDesktopDefaultTerminalShellInput
  ): Promise<DesktopSettingsSnapshot> {
    const defaultTerminalShellId = normalizeDefaultTerminalShellId(input.defaultTerminalShellId)
    const preferences = patchDesktopPreferences({ defaultTerminalShellId })
    return snapshotWithPreferences(preferences)
  }
}

async function snapshotWithPreferences(
  preferences: DesktopPreferences
): Promise<DesktopSettingsSnapshot> {
  try {
    return await withDaemonRetry(async (client) =>
      buildDesktopSettingsSnapshot(await client.getSettings(), preferences)
    )
  } catch {
    return buildDesktopSettingsSnapshot({}, preferences)
  }
}

export const desktopSettingsService = new DesktopSettingsService()

async function withDaemonRetry<T>(
  operation: (client: OpenHarnessClient) => Promise<T>
): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !message.includes("Failed to fetch") &&
      !message.includes("ECONNREFUSED") &&
      !message.includes("ECONNRESET")
    ) {
      throw error
    }
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}
