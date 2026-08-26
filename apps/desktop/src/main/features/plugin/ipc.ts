import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopPluginActionInput,
  DesktopPluginContextInput,
} from "../../../shared/plugin-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopPluginService } from "./plugin-service"

export const pluginIpcContribution: IpcContribution = {
  id: "plugin",
  register() {
    return [
      {
        channel: IpcChannels.pluginSnapshot,
        handler: (_event, input) =>
          desktopPluginService.snapshot(input as DesktopPluginContextInput),
      },
      {
        channel: IpcChannels.pluginEnable,
        handler: (_event, input) => desktopPluginService.enable(input as DesktopPluginActionInput),
      },
      {
        channel: IpcChannels.pluginDisable,
        handler: (_event, input) => desktopPluginService.disable(input as DesktopPluginActionInput),
      },
      {
        channel: IpcChannels.pluginUninstall,
        handler: (_event, input) =>
          desktopPluginService.uninstall(input as DesktopPluginActionInput),
      },
      {
        channel: IpcChannels.pluginReload,
        handler: (_event, input) => desktopPluginService.reload(input as DesktopPluginContextInput),
      },
    ]
  },
}
