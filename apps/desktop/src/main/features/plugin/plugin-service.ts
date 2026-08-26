import { resolve } from "node:path"

import type { OpenHarnessClient } from "@openharness/client"

import type {
  DesktopPluginActionInput,
  DesktopPluginContextInput,
  DesktopPluginSnapshot,
} from "../../../shared/plugin-types"
import { desktopSessionService } from "../session/session-service"

export class DesktopPluginService {
  async snapshot(input: DesktopPluginContextInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    const result = await withDaemonRetry((client) => client.listPlugins({ cwd }))
    return { cwd, plugins: result.plugins, warnings: result.warnings }
  }

  async enable(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await withDaemonRetry((client) => client.enablePlugin(requirePluginId(input.pluginId), { cwd }))
    return await this.snapshot({ cwd })
  }

  async disable(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await withDaemonRetry((client) =>
      client.disablePlugin(requirePluginId(input.pluginId), { cwd })
    )
    return await this.snapshot({ cwd })
  }

  async uninstall(input: DesktopPluginActionInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    await withDaemonRetry((client) =>
      client.uninstallPlugin(requirePluginId(input.pluginId), { cwd })
    )
    return await this.snapshot({ cwd })
  }

  async reload(input: DesktopPluginContextInput): Promise<DesktopPluginSnapshot> {
    const cwd = normalizeCwd(input.cwd)
    const result = await withDaemonRetry((client) => client.reloadPlugins({ cwd }))
    return { cwd, plugins: result.plugins, warnings: result.warnings }
  }
}

export const desktopPluginService = new DesktopPluginService()

function normalizeCwd(value: string): string {
  return resolve(value.trim() || process.cwd())
}

function requirePluginId(value: string): string {
  const pluginId = value.trim()
  if (!pluginId) throw new Error("缺少插件 ID。")
  return pluginId
}

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
