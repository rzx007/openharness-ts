import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  DesktopTerminalCreateInput,
  DesktopTerminalReadInput,
  DesktopTerminalResizeInput,
  DesktopTerminalWriteInput,
} from "../../../shared/terminal-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopTerminalService } from "./terminal-service"

export const terminalIpcContribution: IpcContribution = {
  id: "terminal",
  register() {
    return [
      {
        channel: IpcChannels.terminalCreate,
        handler: (event, input) =>
          desktopTerminalService.create(event.sender, input as DesktopTerminalCreateInput),
      },
      {
        channel: IpcChannels.terminalWrite,
        handler: (event, input) =>
          desktopTerminalService.write(event.sender, input as DesktopTerminalWriteInput),
      },
      {
        channel: IpcChannels.terminalResize,
        handler: (event, input) =>
          desktopTerminalService.resize(event.sender, input as DesktopTerminalResizeInput),
      },
      {
        channel: IpcChannels.terminalRead,
        handler: (event, input) =>
          desktopTerminalService.read(event.sender, input as DesktopTerminalReadInput),
      },
      {
        channel: IpcChannels.terminalKill,
        handler: (event, terminalId) =>
          desktopTerminalService.kill(event.sender, String(terminalId)),
      },
      {
        channel: IpcChannels.terminalList,
        handler: (event) => desktopTerminalService.list(event.sender),
      },
    ]
  },
}
