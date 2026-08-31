import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  UpdateDesktopNotificationModeInput,
  UpdateDesktopWorkStyleInput,
} from "../../../shared/settings-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSettingsService } from "./settings-service"

export const settingsIpcContribution: IpcContribution = {
  id: "settings",
  register() {
    return [
      {
        channel: IpcChannels.settingsSnapshot,
        handler: () => desktopSettingsService.snapshot(),
      },
      {
        channel: IpcChannels.settingsUpdateWorkStyle,
        handler: (_event, input) =>
          desktopSettingsService.updateWorkStyle(input as UpdateDesktopWorkStyleInput),
      },
      {
        channel: IpcChannels.settingsUpdateNotificationMode,
        handler: (_event, input) =>
          desktopSettingsService.updateNotificationMode(
            input as UpdateDesktopNotificationModeInput
          ),
      },
    ]
  },
}
