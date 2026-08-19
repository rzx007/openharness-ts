import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DisconnectDesktopProviderInput,
} from "../../../shared/provider-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopProviderService } from "./provider-service"

export const providerIpcContribution: IpcContribution = {
  id: "provider",
  register() {
    return [
      { channel: IpcChannels.providerSnapshot, handler: () => desktopProviderService.snapshot() },
      {
        channel: IpcChannels.providerConnect,
        handler: (_event, input) =>
          desktopProviderService.connect(input as ConnectDesktopProviderInput),
      },
      {
        channel: IpcChannels.providerActivate,
        handler: (_event, input) =>
          desktopProviderService.activate(input as ActivateDesktopProviderInput),
      },
      {
        channel: IpcChannels.providerDisconnect,
        handler: (_event, input) =>
          desktopProviderService.disconnect(input as DisconnectDesktopProviderInput),
      },
    ]
  },
}
