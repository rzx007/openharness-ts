import type {
  CreateDesktopSessionInput,
  DesktopBootstrapData,
  DesktopProjectDetails,
  DesktopSessionRecord,
  DesktopSessionView,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SendDesktopPromptInput,
} from "./session-types"
import type {
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceCopyPathInput,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
} from "./workspace-types"

export const IpcChannels = {
  appGetInfo: "app:get-info",
  appGetPlatform: "app:get-platform",
  appQuit: "app:quit",

  windowShowMain: "window:show-main",
  windowMinimize: "window:minimize",
  windowClose: "window:close",
  windowToggleMaximize: "window:toggle-maximize",
  windowIsMaximized: "window:is-maximized",

  trayFlash: "tray:flash",
  trayStopFlash: "tray:stop-flash",
  trayNotify: "tray:notify",

  petShow: "pet:show",
  petHide: "pet:hide",
  petToggle: "pet:toggle",
  petGetState: "pet:get-state",
  petSetAlwaysOnTop: "pet:set-always-on-top",
  petSetIgnoreMouseEvents: "pet:set-ignore-mouse-events",

  sessionBootstrap: "session:bootstrap",
  sessionChooseProject: "session:choose-project",
  sessionInspectProject: "session:inspect-project",
  projectRename: "project:rename",
  projectSetPinned: "project:set-pinned",
  projectRemove: "project:remove",
  projectRebind: "project:rebind",
  sessionCreate: "session:create",
  sessionOpen: "session:open",
  sessionClose: "session:close",
  sessionSendPrompt: "session:send-prompt",
  sessionInterrupt: "session:interrupt",
  sessionReplyPermission: "session:reply-permission",
  sessionRename: "session:rename",
  sessionSetPinned: "session:set-pinned",
  sessionArchive: "session:archive",

  workspaceListFiles: "workspace:list-files",
  workspaceReadFile: "workspace:read-file",
  workspaceRevealPath: "workspace:reveal-path",
  workspaceCopyPath: "workspace:copy-path",
} as const

export const IpcEvents = {
  sessionUpdated: "session:updated",
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

export interface DesktopAppInfo {
  name: string
  version: string
  isPackaged: boolean
}

export interface PlatformInfo {
  platform: string
  isMac: boolean
  isWindows: boolean
  isLinux: boolean
}

export interface TrayNotificationOptions {
  title: string
  body: string
  silent?: boolean
  showWhenFocused?: boolean
}

export interface PetPosition {
  x: number
  y: number
}

export interface PetState {
  visible: boolean
  alwaysOnTop: boolean
  ignoreMouseEvents: boolean
  position: PetPosition | null
}

export interface IpcInvokeMap {
  [IpcChannels.appGetInfo]: { args: []; result: DesktopAppInfo }
  [IpcChannels.appGetPlatform]: { args: []; result: PlatformInfo }
  [IpcChannels.appQuit]: { args: []; result: void }

  [IpcChannels.windowShowMain]: { args: []; result: void }
  [IpcChannels.windowMinimize]: { args: []; result: void }
  [IpcChannels.windowClose]: { args: []; result: void }
  [IpcChannels.windowToggleMaximize]: { args: []; result: void }
  [IpcChannels.windowIsMaximized]: { args: []; result: boolean }

  [IpcChannels.trayFlash]: { args: []; result: void }
  [IpcChannels.trayStopFlash]: { args: []; result: void }
  [IpcChannels.trayNotify]: { args: [options: TrayNotificationOptions]; result: void }

  [IpcChannels.petShow]: { args: []; result: void }
  [IpcChannels.petHide]: { args: []; result: void }
  [IpcChannels.petToggle]: { args: []; result: PetState }
  [IpcChannels.petGetState]: { args: []; result: PetState }
  [IpcChannels.petSetAlwaysOnTop]: { args: [value: boolean]; result: PetState }
  [IpcChannels.petSetIgnoreMouseEvents]: { args: [value: boolean]; result: PetState }

  [IpcChannels.sessionBootstrap]: { args: []; result: DesktopBootstrapData }
  [IpcChannels.sessionChooseProject]: { args: []; result: DesktopProjectDetails | null }
  [IpcChannels.sessionInspectProject]: {
    args: [path: string]
    result: DesktopProjectDetails
  }
  [IpcChannels.projectRename]: {
    args: [input: RenameDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectSetPinned]: {
    args: [input: PinDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectRemove]: { args: [path: string]; result: void }
  [IpcChannels.projectRebind]: {
    args: [projectId: string]
    result: {
      project: DesktopProjectDetails["project"]
      sessions: DesktopSessionRecord[]
      archivedSessions: DesktopSessionRecord[]
    } | null
  }
  [IpcChannels.sessionCreate]: {
    args: [input: CreateDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionOpen]: { args: [sessionId: string]; result: DesktopSessionView }
  [IpcChannels.sessionClose]: { args: []; result: void }
  [IpcChannels.sessionSendPrompt]: { args: [input: SendDesktopPromptInput]; result: void }
  [IpcChannels.sessionInterrupt]: { args: [sessionId: string]; result: void }
  [IpcChannels.sessionReplyPermission]: {
    args: [input: ReplyDesktopPermissionInput]
    result: void
  }
  [IpcChannels.sessionRename]: {
    args: [input: RenameDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionSetPinned]: {
    args: [input: PinDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionArchive]: {
    args: [sessionId: string]
    result: DesktopSessionRecord
  }

  [IpcChannels.workspaceListFiles]: {
    args: [input: WorkspaceListFilesInput]
    result: WorkspaceListFilesResult
  }
  [IpcChannels.workspaceReadFile]: {
    args: [input: WorkspaceReadFileInput]
    result: WorkspaceReadFileResult
  }
  [IpcChannels.workspaceRevealPath]: {
    args: [input: WorkspaceRevealPathInput]
    result: void
  }
  [IpcChannels.workspaceCopyPath]: {
    args: [input: WorkspaceCopyPathInput]
    result: string
  }
}

export type IpcResult<C extends IpcChannel> = IpcInvokeMap[C]["result"]
