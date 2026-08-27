import type {
  CreateDesktopSessionInput,
  CheckoutDesktopProjectBranchInput,
  CreateDesktopProjectBranchInput,
  DesktopBootstrapData,
  DesktopDaemonStatus,
  DesktopProjectDetails,
  DesktopCommandCatalogEntry,
  DesktopSessionRecord,
  DesktopSessionView,
  CloseDesktopAuxSessionInput,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
  InvokeDesktopCommandInput,
  InterruptDesktopSessionInput,
  PromoteDesktopQueuedPromptInput,
  CancelDesktopQueuedPromptInput,
  PinDesktopSessionInput,
  PinDesktopProjectInput,
  OpenDesktopAuxSessionInput,
  RenameDesktopProjectInput,
  RenameDesktopSessionInput,
  ReplyDesktopPermissionInput,
  SetDefaultDesktopProjectShellInput,
  SendDesktopPromptInput,
  SetDefaultDesktopModelInput,
  SetDefaultDesktopPermissionModeInput,
  UpdateDesktopSessionModelInput,
  UpdateDesktopSessionPermissionModeInput,
} from "./session-types"
import type {
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceCopyPathInput,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
  WorkspaceOpenWithInput,
  WorkspaceOpener,
} from "./workspace-types"
import type {
  DesktopTerminalCreateInput,
  DesktopTerminalReadInput,
  DesktopTerminalReadResult,
  DesktopTerminalRecord,
  DesktopTerminalResizeInput,
  DesktopTerminalWriteInput,
} from "./terminal-types"
import type {
  CreateDesktopScheduledTaskInput,
  DesktopScheduledRun,
  DesktopScheduledStatus,
  DesktopScheduledTask,
  ListDesktopScheduledRunsInput,
  UpdateDesktopScheduledTaskInput,
} from "./schedule-types"
import type {
  ActivateDesktopProviderInput,
  ConnectDesktopProviderInput,
  DesktopProviderSnapshot,
  DisconnectDesktopProviderInput,
  CreateDesktopCustomProviderInput,
  UpdateDesktopCustomProviderInput,
  RemoveDesktopCustomProviderInput,
} from "./provider-types"
import type {
  DesktopGitChangesInput,
  DesktopGitChangesResult,
  DesktopGitFileDiffInput,
  DesktopGitFileDiffResult,
} from "./git-types"
import type {
  DesktopPluginActionInput,
  DesktopPluginContextInput,
  DesktopPluginSnapshot,
} from "./plugin-types"
import type { DesktopSettingsSnapshot, UpdateDesktopWorkStyleInput } from "./settings-types"

export const IpcChannels = {
  appGetInfo: "app:get-info",
  appGetPlatform: "app:get-platform",
  appQuit: "app:quit",

  windowShowMain: "window:show-main",
  windowMinimize: "window:minimize",
  windowClose: "window:close",
  windowToggleMaximize: "window:toggle-maximize",
  windowIsMaximized: "window:is-maximized",
  windowGetZoomLevel: "window:get-zoom-level",
  windowSetZoomLevel: "window:set-zoom-level",

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
  sessionDaemonStatus: "session:daemon-status",
  sessionChooseProject: "session:choose-project",
  sessionInspectProject: "session:inspect-project",
  sessionListCommands: "session:list-commands",
  projectRename: "project:rename",
  projectSetPinned: "project:set-pinned",
  projectSetDefaultShell: "project:set-default-shell",
  projectRemove: "project:remove",
  projectRebind: "project:rebind",
  projectCheckoutBranch: "project:checkout-branch",
  projectCreateBranch: "project:create-branch",
  sessionCreate: "session:create",
  sessionOpen: "session:open",
  sessionAuxOpen: "session:aux-open",
  sessionAuxClose: "session:aux-close",
  sessionFork: "session:fork",
  sessionClose: "session:close",
  sessionSendPrompt: "session:send-prompt",
  sessionInvokeCommand: "session:invoke-command",
  sessionEditLatestPrompt: "session:edit-latest-prompt",
  sessionPromoteQueuedPrompt: "session:promote-queued-prompt",
  sessionCancelQueuedPrompt: "session:cancel-queued-prompt",
  sessionInterrupt: "session:interrupt",
  sessionReplyPermission: "session:reply-permission",
  sessionSetDefaultModel: "session:set-default-model",
  sessionSetDefaultPermissionMode: "session:set-default-permission-mode",
  sessionUpdateModel: "session:update-model",
  sessionUpdatePermissionMode: "session:update-permission-mode",
  sessionRename: "session:rename",
  sessionSetPinned: "session:set-pinned",
  sessionArchive: "session:archive",
  sessionDelete: "session:delete",

  workspaceListFiles: "workspace:list-files",
  workspaceReadFile: "workspace:read-file",
  workspaceRevealPath: "workspace:reveal-path",
  workspaceCopyPath: "workspace:copy-path",
  workspaceListOpeners: "workspace:list-openers",
  workspaceOpenWith: "workspace:open-with",

  gitChanges: "git:changes",
  gitFileDiff: "git:file-diff",

  clipboardReadText: "clipboard:read-text",
  clipboardWriteText: "clipboard:write-text",

  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalRead: "terminal:read",
  terminalKill: "terminal:kill",
  terminalList: "terminal:list",

  scheduleStatus: "schedule:status",
  scheduleList: "schedule:list",
  scheduleCreate: "schedule:create",
  scheduleUpdate: "schedule:update",
  scheduleRemove: "schedule:remove",
  scheduleRunNow: "schedule:run-now",
  scheduleListRuns: "schedule:list-runs",
  scheduleSetRunUnread: "schedule:set-run-unread",

  providerSnapshot: "provider:snapshot",
  providerConnect: "provider:connect",
  providerActivate: "provider:activate",
  providerDisconnect: "provider:disconnect",
  providerCustomCreate: "provider:custom-create",
  providerCustomUpdate: "provider:custom-update",
  providerCustomRemove: "provider:custom-remove",

  pluginSnapshot: "plugin:snapshot",
  pluginEnable: "plugin:enable",
  pluginDisable: "plugin:disable",
  pluginUninstall: "plugin:uninstall",
  pluginReload: "plugin:reload",

  settingsSnapshot: "settings:snapshot",
  settingsUpdateWorkStyle: "settings:update-work-style",
} as const

export const IpcEvents = {
  windowMaximizedChanged: "window:maximized-changed",
  petClicked: "pet:clicked",
  sessionUpdated: "session:updated",
  sessionAuxUpdated: "session:aux-updated",
  sessionDaemonStatusChanged: "session:daemon-status-changed",
  terminalData: "terminal:data",
  terminalStatus: "terminal:status",
  terminalExit: "terminal:exit",
  terminalError: "terminal:error",
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
  [IpcChannels.windowGetZoomLevel]: { args: []; result: number }
  [IpcChannels.windowSetZoomLevel]: { args: [level: number]; result: number }

  [IpcChannels.trayFlash]: { args: []; result: void }
  [IpcChannels.trayStopFlash]: { args: []; result: void }
  [IpcChannels.trayNotify]: { args: [options: TrayNotificationOptions]; result: void }

  [IpcChannels.petShow]: { args: []; result: void }
  [IpcChannels.petHide]: { args: []; result: void }
  [IpcChannels.petToggle]: { args: []; result: PetState }
  [IpcChannels.petGetState]: { args: []; result: PetState }
  [IpcChannels.petSetAlwaysOnTop]: { args: [value: boolean]; result: PetState }
  [IpcChannels.petSetIgnoreMouseEvents]: { args: [value: boolean]; result: PetState }

  [IpcChannels.settingsSnapshot]: { args: []; result: DesktopSettingsSnapshot }
  [IpcChannels.settingsUpdateWorkStyle]: {
    args: [input: UpdateDesktopWorkStyleInput]
    result: DesktopSettingsSnapshot
  }

  [IpcChannels.sessionBootstrap]: { args: []; result: DesktopBootstrapData }
  [IpcChannels.sessionDaemonStatus]: { args: []; result: DesktopDaemonStatus }
  [IpcChannels.sessionChooseProject]: { args: []; result: DesktopProjectDetails | null }
  [IpcChannels.sessionInspectProject]: {
    args: [path: string]
    result: DesktopProjectDetails
  }
  [IpcChannels.sessionListCommands]: {
    args: [cwd: string]
    result: DesktopCommandCatalogEntry[]
  }
  [IpcChannels.projectRename]: {
    args: [input: RenameDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectSetPinned]: {
    args: [input: PinDesktopProjectInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectSetDefaultShell]: {
    args: [input: SetDefaultDesktopProjectShellInput]
    result: DesktopProjectDetails["project"]
  }
  [IpcChannels.projectRemove]: { args: [path: string]; result: void }
  [IpcChannels.projectRebind]: {
    args: [projectId: string]
    result: DesktopProjectDetails["project"] | null
  }
  [IpcChannels.projectCheckoutBranch]: {
    args: [input: CheckoutDesktopProjectBranchInput]
    result: DesktopProjectDetails
  }
  [IpcChannels.projectCreateBranch]: {
    args: [input: CreateDesktopProjectBranchInput]
    result: DesktopProjectDetails
  }
  [IpcChannels.sessionCreate]: {
    args: [input: CreateDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionOpen]: { args: [sessionId: string]; result: DesktopSessionView }
  [IpcChannels.sessionAuxOpen]: {
    args: [input: OpenDesktopAuxSessionInput]
    result: DesktopSessionView
  }
  [IpcChannels.sessionAuxClose]: { args: [input: CloseDesktopAuxSessionInput]; result: void }
  [IpcChannels.sessionFork]: {
    args: [input: ForkDesktopSessionInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionClose]: { args: []; result: void }
  [IpcChannels.sessionSendPrompt]: { args: [input: SendDesktopPromptInput]; result: void }
  [IpcChannels.sessionInvokeCommand]: { args: [input: InvokeDesktopCommandInput]; result: void }
  [IpcChannels.sessionEditLatestPrompt]: {
    args: [input: EditLatestDesktopPromptInput]
    result: void
  }
  [IpcChannels.sessionPromoteQueuedPrompt]: {
    args: [input: PromoteDesktopQueuedPromptInput]
    result: void
  }
  [IpcChannels.sessionCancelQueuedPrompt]: {
    args: [input: CancelDesktopQueuedPromptInput]
    result: void
  }
  [IpcChannels.sessionInterrupt]: { args: [input: InterruptDesktopSessionInput]; result: void }
  [IpcChannels.sessionReplyPermission]: {
    args: [input: ReplyDesktopPermissionInput]
    result: void
  }
  [IpcChannels.sessionSetDefaultModel]: {
    args: [input: SetDefaultDesktopModelInput]
    result: DesktopBootstrapData
  }
  [IpcChannels.sessionSetDefaultPermissionMode]: {
    args: [input: SetDefaultDesktopPermissionModeInput]
    result: DesktopBootstrapData
  }
  [IpcChannels.sessionUpdateModel]: {
    args: [input: UpdateDesktopSessionModelInput]
    result: DesktopSessionRecord
  }
  [IpcChannels.sessionUpdatePermissionMode]: {
    args: [input: UpdateDesktopSessionPermissionModeInput]
    result: DesktopSessionRecord
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
  [IpcChannels.sessionDelete]: {
    args: [sessionId: string]
    result: string[]
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
  [IpcChannels.workspaceListOpeners]: {
    args: []
    result: WorkspaceOpener[]
  }
  [IpcChannels.workspaceOpenWith]: {
    args: [input: WorkspaceOpenWithInput]
    result: void
  }

  [IpcChannels.gitChanges]: {
    args: [input: DesktopGitChangesInput]
    result: DesktopGitChangesResult
  }
  [IpcChannels.gitFileDiff]: {
    args: [input: DesktopGitFileDiffInput]
    result: DesktopGitFileDiffResult
  }

  [IpcChannels.clipboardReadText]: {
    args: []
    result: string
  }
  [IpcChannels.clipboardWriteText]: {
    args: [text: string]
    result: void
  }

  [IpcChannels.terminalCreate]: {
    args: [input: DesktopTerminalCreateInput]
    result: DesktopTerminalRecord
  }
  [IpcChannels.terminalWrite]: {
    args: [input: DesktopTerminalWriteInput]
    result: void
  }
  [IpcChannels.terminalResize]: {
    args: [input: DesktopTerminalResizeInput]
    result: void
  }
  [IpcChannels.terminalRead]: {
    args: [input: DesktopTerminalReadInput]
    result: DesktopTerminalReadResult
  }
  [IpcChannels.terminalKill]: {
    args: [terminalId: string]
    result: void
  }
  [IpcChannels.terminalList]: {
    args: []
    result: DesktopTerminalRecord[]
  }
  [IpcChannels.scheduleStatus]: { args: []; result: DesktopScheduledStatus }
  [IpcChannels.scheduleList]: { args: []; result: DesktopScheduledTask[] }
  [IpcChannels.scheduleCreate]: {
    args: [input: CreateDesktopScheduledTaskInput]
    result: DesktopScheduledTask
  }
  [IpcChannels.scheduleUpdate]: {
    args: [id: string, input: UpdateDesktopScheduledTaskInput]
    result: DesktopScheduledTask
  }
  [IpcChannels.scheduleRemove]: { args: [id: string]; result: void }
  [IpcChannels.scheduleRunNow]: { args: [id: string]; result: DesktopScheduledRun }
  [IpcChannels.scheduleListRuns]: {
    args: [input: ListDesktopScheduledRunsInput]
    result: DesktopScheduledRun[]
  }
  [IpcChannels.scheduleSetRunUnread]: {
    args: [id: string, unread: boolean]
    result: DesktopScheduledRun
  }
  [IpcChannels.providerSnapshot]: { args: []; result: DesktopProviderSnapshot }
  [IpcChannels.providerConnect]: {
    args: [input: ConnectDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerActivate]: {
    args: [input: ActivateDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerDisconnect]: {
    args: [input: DisconnectDesktopProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomCreate]: {
    args: [input: CreateDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomUpdate]: {
    args: [input: UpdateDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.providerCustomRemove]: {
    args: [input: RemoveDesktopCustomProviderInput]
    result: DesktopProviderSnapshot
  }
  [IpcChannels.pluginSnapshot]: {
    args: [input: DesktopPluginContextInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginEnable]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginDisable]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginUninstall]: {
    args: [input: DesktopPluginActionInput]
    result: DesktopPluginSnapshot
  }
  [IpcChannels.pluginReload]: {
    args: [input: DesktopPluginContextInput]
    result: DesktopPluginSnapshot
  }
}
