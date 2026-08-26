import type { PluginInfo } from "@openharness/client"

export type DesktopPluginInfo = PluginInfo

export interface DesktopPluginContextInput {
  cwd: string
}

export interface DesktopPluginActionInput extends DesktopPluginContextInput {
  pluginId: string
}

export interface DesktopPluginSnapshot {
  cwd: string
  plugins: DesktopPluginInfo[]
  warnings: string[]
}
