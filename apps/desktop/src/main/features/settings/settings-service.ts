import type { OpenHarnessClient } from "@openharness/client"

import { buildDesktopSettingsSnapshot, isDesktopWorkStyle } from "../../../shared/settings-types"
import type {
  DesktopSettingsSnapshot,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import { desktopSessionService } from "../session/session-service"

export class DesktopSettingsService {
  snapshot(): Promise<DesktopSettingsSnapshot> {
    return withDaemonRetry(async (client) =>
      buildDesktopSettingsSnapshot(await client.getSettings())
    )
  }

  async updateWorkStyle(input: UpdateDesktopWorkStyleInput): Promise<DesktopSettingsSnapshot> {
    if (!isDesktopWorkStyle(input.workStyle)) {
      throw new Error("未知的工作风格，请选择务实或高效。")
    }
    return withDaemonRetry(async (client) => {
      const settings = await client.patchSettings({ workStyle: input.workStyle })
      return buildDesktopSettingsSnapshot(settings)
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
