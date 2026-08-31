import { IpcChannels } from "../../../shared/ipc-channels";
import type {
  CheckoutDesktopProjectBranchInput,
  CloseDesktopAuxSessionInput,
  CreateDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  InterruptDesktopSessionInput,
  PromoteDesktopQueuedPromptInput,
  CancelDesktopQueuedPromptInput,
  OpenDesktopAuxSessionInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
} from "../../../shared/session-types";
import type {
  DesktopContextCandidateAccept,
  DesktopContextEntryInput,
  DesktopContextEntryTarget,
  DesktopContextEntryUpdate,
  DesktopContextQuery,
} from "../../../shared/context-types";
import type { IpcContribution } from "../../core/ipc/types";
import { desktopSessionService } from "./session-service";

export const sessionIpcContribution: IpcContribution = {
  id: "session",
  register() {
    return [
      {
        channel: IpcChannels.sessionBootstrap,
        handler: () => desktopSessionService.bootstrap(),
      },
      {
        channel: IpcChannels.sessionDaemonStatus,
        handler: () => desktopSessionService.getDaemonStatus(),
      },
      {
        channel: IpcChannels.sessionChooseProject,
        handler: (event) => desktopSessionService.chooseProject(event.sender),
      },
      {
        channel: IpcChannels.sessionInspectProject,
        handler: (_event, path) =>
          desktopSessionService.inspectProject(String(path ?? "")),
      },
      {
        channel: IpcChannels.sessionListCommands,
        handler: (_event, cwd) =>
          desktopSessionService.listCommands(String(cwd ?? "")),
      },
      {
        channel: IpcChannels.projectRename,
        handler: (_event, input) =>
          desktopSessionService.renameProject(
            input as RenameDesktopProjectInput,
          ),
      },
      {
        channel: IpcChannels.projectSetPinned,
        handler: (_event, input) =>
          desktopSessionService.setProjectPinned(
            input as PinDesktopProjectInput,
          ),
      },
      {
        channel: IpcChannels.projectSetDefaultShell,
        handler: (_event, input) =>
          desktopSessionService.setProjectDefaultShell(
            input as SetDefaultDesktopProjectShellInput,
          ),
      },
      {
        channel: IpcChannels.projectRemove,
        handler: (_event, path) =>
          desktopSessionService.removeProject(String(path ?? "")),
      },
      {
        channel: IpcChannels.projectRebind,
        handler: (event, projectId) =>
          desktopSessionService.rebindProject(
            event.sender,
            String(projectId ?? ""),
          ),
      },
      {
        channel: IpcChannels.projectCheckoutBranch,
        handler: (_event, input) =>
          desktopSessionService.checkoutProjectBranch(
            input as CheckoutDesktopProjectBranchInput,
          ),
      },
      {
        channel: IpcChannels.projectCreateBranch,
        handler: (_event, input) =>
          desktopSessionService.createProjectBranch(
            input as CreateDesktopProjectBranchInput,
          ),
      },
      {
        channel: IpcChannels.sessionCreate,
        handler: (_event, input) =>
          desktopSessionService.createSession(
            input as CreateDesktopSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionOpen,
        handler: (event, sessionId) =>
          desktopSessionService.openSession(
            event.sender,
            String(sessionId ?? ""),
          ),
      },
      {
        channel: IpcChannels.sessionAuxOpen,
        handler: (event, input) =>
          desktopSessionService.openAuxSession(
            event.sender,
            input as OpenDesktopAuxSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionAuxClose,
        handler: (event, input) =>
          desktopSessionService.closeAuxSession(
            event.sender.id,
            input as CloseDesktopAuxSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionFork,
        handler: (_event, input) =>
          desktopSessionService.forkSession(input as ForkDesktopSessionInput),
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
        channel: IpcChannels.sessionEditLatestPrompt,
        handler: (_event, input) =>
          desktopSessionService.editLatestPrompt(
            input as EditLatestDesktopPromptInput,
          ),
      },
      {
        channel: IpcChannels.sessionPromoteQueuedPrompt,
        handler: (_event, input) =>
          desktopSessionService.promoteQueuedPrompt(
            input as PromoteDesktopQueuedPromptInput,
          ),
      },
      {
        channel: IpcChannels.sessionCancelQueuedPrompt,
        handler: (_event, input) =>
          desktopSessionService.cancelQueuedPrompt(
            input as CancelDesktopQueuedPromptInput,
          ),
      },
      {
        channel: IpcChannels.sessionInterrupt,
        handler: (_event, input) =>
          desktopSessionService.interruptSession(
            input as InterruptDesktopSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionReplyPermission,
        handler: (_event, input) =>
          desktopSessionService.replyPermission(
            input as ReplyDesktopPermissionInput,
          ),
      },
      {
        channel: IpcChannels.sessionSetDefaultModel,
        handler: (_event, input) =>
          desktopSessionService.setDefaultModel(
            input as SetDefaultDesktopModelInput,
          ),
      },
      {
        channel: IpcChannels.sessionSetDefaultPermissionMode,
        handler: (_event, input) =>
          desktopSessionService.setDefaultPermissionMode(
            input as SetDefaultDesktopPermissionModeInput,
          ),
      },
      {
        channel: IpcChannels.sessionUpdateModel,
        handler: (_event, input) =>
          desktopSessionService.updateSessionModel(
            input as UpdateDesktopSessionModelInput,
          ),
      },
      {
        channel: IpcChannels.sessionUpdatePermissionMode,
        handler: (_event, input) =>
          desktopSessionService.updateSessionPermissionMode(
            input as UpdateDesktopSessionPermissionModeInput,
          ),
      },
      {
        channel: IpcChannels.sessionRename,
        handler: (_event, input) =>
          desktopSessionService.renameSession(
            input as RenameDesktopSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionSetPinned,
        handler: (_event, input) =>
          desktopSessionService.setSessionPinned(
            input as PinDesktopSessionInput,
          ),
      },
      {
        channel: IpcChannels.sessionArchive,
        handler: (event, sessionId) =>
          desktopSessionService.archiveSession(
            event.sender.id,
            String(sessionId ?? ""),
          ),
      },
      {
        channel: IpcChannels.sessionDelete,
        handler: (event, sessionId) =>
          desktopSessionService.deleteSession(
            event.sender.id,
            String(sessionId ?? ""),
          ),
      },
      {
        channel: IpcChannels.contextList,
        handler: (_event, input) =>
          desktopSessionService.listContext(input as DesktopContextQuery),
      },
      {
        channel: IpcChannels.contextAdd,
        handler: (_event, input) =>
          desktopSessionService.addContext(input as DesktopContextEntryInput),
      },
      {
        channel: IpcChannels.contextUpdate,
        handler: (_event, input) =>
          desktopSessionService.updateContext(
            input as DesktopContextEntryUpdate,
          ),
      },
      {
        channel: IpcChannels.contextRemove,
        handler: (_event, input) =>
          desktopSessionService.removeContext(
            input as DesktopContextEntryTarget,
          ),
      },
      {
        channel: IpcChannels.contextCandidates,
        handler: (_event, input) =>
          desktopSessionService.listContextCandidates(input as { cwd: string }),
      },
      {
        channel: IpcChannels.contextAccept,
        handler: (_event, input) =>
          desktopSessionService.acceptContextCandidate(
            input as DesktopContextCandidateAccept,
          ),
      },
      {
        channel: IpcChannels.contextReject,
        handler: (_event, input) =>
          desktopSessionService.rejectContextCandidate(
            input as DesktopContextEntryTarget,
          ),
      },
      {
        channel: IpcChannels.contextPreview,
        handler: (_event, input) =>
          desktopSessionService.getContextPreview(input as { cwd: string }),
      },
      {
        channel: IpcChannels.contextStatus,
        handler: (_event, input) =>
          desktopSessionService.getContextStatus(input as { cwd: string }),
      },
    ];
  },
};
