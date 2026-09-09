import { app } from "electron"

import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopPluginActionInput,
  DesktopPluginArchiveCancelInput,
  DesktopPluginArchiveConfirmInput,
  DesktopPluginArchiveImportInput,
  DesktopPluginContextInput,
} from "../../../shared/plugin-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopPluginService, type DesktopPluginService } from "./plugin-service"

type PluginIpcService = Pick<
  DesktopPluginService,
  | "snapshot"
  | "enable"
  | "disable"
  | "uninstall"
  | "reload"
  | "importArchive"
  | "confirmArchive"
  | "cancelArchive"
  | "clearArchiveSelections"
>

export function createPluginIpcContribution(service: PluginIpcService): IpcContribution {
  let quitCleanupRegistered = false

  return {
    id: "plugin",
    register() {
      if (!quitCleanupRegistered) {
        quitCleanupRegistered = true
        app.once("before-quit", () => service.clearArchiveSelections())
      }
      return [
        {
          channel: IpcChannels.pluginSnapshot,
          handler: (_event, input) => service.snapshot(input as DesktopPluginContextInput),
        },
        {
          channel: IpcChannels.pluginEnable,
          handler: (_event, input) => service.enable(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginDisable,
          handler: (_event, input) => service.disable(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginUninstall,
          handler: (_event, input) => service.uninstall(input as DesktopPluginActionInput),
        },
        {
          channel: IpcChannels.pluginReload,
          handler: (_event, input) => service.reload(input as DesktopPluginContextInput),
        },
        {
          channel: IpcChannels.pluginImportArchive,
          handler: (event, input) =>
            service.importArchive(event.sender, { cwd: (input as DesktopPluginArchiveImportInput).cwd }),
        },
        {
          channel: IpcChannels.pluginConfirmArchive,
          handler: (_event, input) => {
            const value = input as DesktopPluginArchiveConfirmInput
            return service.confirmArchive({ cwd: value.cwd, selectionId: value.selectionId })
          },
        },
        {
          channel: IpcChannels.pluginCancelArchive,
          handler: (_event, input) =>
            service.cancelArchive({ selectionId: (input as DesktopPluginArchiveCancelInput).selectionId }),
        },
      ]
    },
  }
}

export const pluginIpcContribution = createPluginIpcContribution(desktopPluginService)
