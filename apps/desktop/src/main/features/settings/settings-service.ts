import type { OpenHarnessClient } from "@openharness/client"

import {
  buildDesktopSettingsSnapshot,
  isDesktopNotificationMode,
  isDesktopWorkStyle,
} from "../../../shared/settings-types"
import type {
  UpdateDesktopNotificationModeInput,
  DesktopSettingsSnapshot,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import { desktopSessionService } from "../session/session-service"
import { getDesktopPreferences, patchDesktopPreferences } from "./desktop-preferences"

export class DesktopSettingsService {
  snapshot(): Promise<DesktopSettingsSnapshot> {
    const preferences = getDesktopPreferences()
    return withDaemonRetry(async (client) =>
      buildDesktopSettingsSnapshot(await client.getSettings(), preferences)
    )
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
    return withDaemonRetry(async (client) => {
      const settings = await client.getSettings()
      return buildDesktopSettingsSnapshot(settings, preferences)
    })
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
