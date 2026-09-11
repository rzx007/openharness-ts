import { IpcChannels } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { daemonAutoStartService } from "./daemon-autostart-service"

export const daemonAutoStartIpcContribution: IpcContribution = {
  id: "daemon-autostart",
  register() {
    return [
      {
        channel: IpcChannels.daemonAutoStartSnapshot,
        handler: () => daemonAutoStartService.snapshot(),
      },
      {
        channel: IpcChannels.daemonAutoStartEnable,
        handler: () => daemonAutoStartService.enable(),
      },
      {
        channel: IpcChannels.daemonAutoStartDisable,
        handler: () => daemonAutoStartService.disable(),
      },
      {
        channel: IpcChannels.daemonAutoStartDismissOnboarding,
        handler: () => daemonAutoStartService.dismissOnboarding(),
      },
    ]
  },
}
