import { IpcChannels } from "../../../shared/ipc-channels"
import type {
  CreateDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SendDesktopPromptInput,
} from "../../../shared/session-types"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSessionService } from "./session-service"

export const sessionIpcContribution: IpcContribution = {
  id: "session",
  register() {
    return [
      {
        channel: IpcChannels.sessionBootstrap,
        handler: () => desktopSessionService.bootstrap(),
      },
      {
        channel: IpcChannels.sessionChooseProject,
        handler: (event) => desktopSessionService.chooseProject(event.sender),
      },
      {
        channel: IpcChannels.sessionInspectProject,
        handler: (_event, path) => desktopSessionService.inspectProject(String(path ?? "")),
      },
      {
        channel: IpcChannels.sessionCreate,
        handler: (_event, input) =>
          desktopSessionService.createSession(input as CreateDesktopSessionInput),
      },
      {
        channel: IpcChannels.sessionOpen,
        handler: (event, sessionId) =>
          desktopSessionService.openSession(event.sender, String(sessionId ?? "")),
      },
      {
        channel: IpcChannels.sessionClose,
        handler: (event) => desktopSessionService.closeSession(event.sender.id),
      },
      {
        channel: IpcChannels.sessionSendPrompt,
        handler: (_event, input) =>
          desktopSessionService.sendPrompt(input as SendDesktopPromptInput),
      },
      {
        channel: IpcChannels.sessionInterrupt,
        handler: (_event, sessionId) =>
          desktopSessionService.interruptSession(String(sessionId ?? "")),
      },
      {
        channel: IpcChannels.sessionReplyPermission,
        handler: (_event, input) =>
          desktopSessionService.replyPermission(input as ReplyDesktopPermissionInput),
      },
    ]
  },
}
