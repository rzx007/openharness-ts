import type {
  DesktopAppInfo,
  PetState,
  PlatformInfo,
  TrayNotificationOptions,
} from "./ipc-channels"
import type {
  CheckoutDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  DesktopBootstrapData,
  DesktopAuxSessionUpdate,
  DesktopDaemonStatus,
  DesktopProjectDetails,
  DesktopSessionRecord,
  DesktopSessionView,
  CloseDesktopAuxSessionInput,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
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
  DesktopTerminalEvent,
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

export type DesktopAPI = {
  app: {
    getInfo: () => Promise<DesktopAppInfo>
    getPlatform: () => Promise<PlatformInfo>
    quit: () => Promise<void>
  }
  window: {
    showMain: () => Promise<void>
    minimize: () => Promise<void>
    close: () => Promise<void>
    toggleMaximize: () => Promise<void>
    isMaximized: () => Promise<boolean>
    getZoomLevel: () => Promise<number>
    setZoomLevel: (level: number) => Promise<number>
    onMaximizedChanged: (listener: (value: boolean) => void) => () => void
  }
  tray: {
    flash: () => Promise<void>
    stopFlash: () => Promise<void>
    notify: (options: TrayNotificationOptions) => Promise<void>
  }
  pet: {
    show: () => Promise<void>
    hide: () => Promise<void>
    toggle: () => Promise<PetState>
    getState: () => Promise<PetState>
    setAlwaysOnTop: (value: boolean) => Promise<PetState>
    setIgnoreMouseEvents: (value: boolean) => Promise<PetState>
  }
  workspace: {
    listFiles: (input: WorkspaceListFilesInput) => Promise<WorkspaceListFilesResult>
    readFile: (input: WorkspaceReadFileInput) => Promise<WorkspaceReadFileResult>
    revealPath: (input: WorkspaceRevealPathInput) => Promise<void>
    copyPath: (input: WorkspaceCopyPathInput) => Promise<string>
    listOpeners: () => Promise<WorkspaceOpener[]>
    openWith: (input: WorkspaceOpenWithInput) => Promise<void>
  }
  clipboard: {
    readText: () => Promise<string>
    writeText: (text: string) => Promise<void>
  }
  terminal: {
    create: (input: DesktopTerminalCreateInput) => Promise<DesktopTerminalRecord>
    write: (input: DesktopTerminalWriteInput) => Promise<void>
    resize: (input: DesktopTerminalResizeInput) => Promise<void>
    read: (input: DesktopTerminalReadInput) => Promise<DesktopTerminalReadResult>
    kill: (terminalId: string) => Promise<void>
    list: () => Promise<DesktopTerminalRecord[]>
    onEvent: (listener: (event: DesktopTerminalEvent) => void) => () => void
  }
  schedules: {
    status: () => Promise<DesktopScheduledStatus>
    list: () => Promise<DesktopScheduledTask[]>
    create: (input: CreateDesktopScheduledTaskInput) => Promise<DesktopScheduledTask>
    update: (id: string, input: UpdateDesktopScheduledTaskInput) => Promise<DesktopScheduledTask>
    remove: (id: string) => Promise<void>
    runNow: (id: string) => Promise<DesktopScheduledRun>
    listRuns: (input: ListDesktopScheduledRunsInput) => Promise<DesktopScheduledRun[]>
    setRunUnread: (id: string, unread: boolean) => Promise<DesktopScheduledRun>
  }
  providers: {
    snapshot: () => Promise<DesktopProviderSnapshot>
    connect: (input: ConnectDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    activate: (input: ActivateDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    disconnect: (input: DisconnectDesktopProviderInput) => Promise<DesktopProviderSnapshot>
    createCustom: (input: CreateDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
    updateCustom: (input: UpdateDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
    removeCustom: (input: RemoveDesktopCustomProviderInput) => Promise<DesktopProviderSnapshot>
  }
  sessions: {
    bootstrap: () => Promise<DesktopBootstrapData>
    daemonStatus: () => Promise<DesktopDaemonStatus>
    chooseProject: () => Promise<DesktopProjectDetails | null>
    inspectProject: (path: string) => Promise<DesktopProjectDetails>
    renameProject: (input: RenameDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    setProjectPinned: (input: PinDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    setProjectDefaultShell: (
      input: SetDefaultDesktopProjectShellInput
    ) => Promise<DesktopProjectDetails["project"]>
    removeProject: (path: string) => Promise<void>
    rebindProject: (projectId: string) => Promise<DesktopProjectDetails["project"] | null>
    checkoutBranch: (input: CheckoutDesktopProjectBranchInput) => Promise<DesktopProjectDetails>
    createBranch: (input: CreateDesktopProjectBranchInput) => Promise<DesktopProjectDetails>
    create: (input: CreateDesktopSessionInput) => Promise<DesktopSessionRecord>
    open: (sessionId: string) => Promise<DesktopSessionView>
    openAux: (input: OpenDesktopAuxSessionInput) => Promise<DesktopSessionView>
    closeAux: (input: CloseDesktopAuxSessionInput) => Promise<void>
    fork: (input: ForkDesktopSessionInput) => Promise<DesktopSessionRecord>
    close: () => Promise<void>
    sendPrompt: (input: SendDesktopPromptInput) => Promise<void>
    editLatestPrompt: (input: EditLatestDesktopPromptInput) => Promise<void>
    interrupt: (sessionId: string) => Promise<void>
    replyPermission: (input: ReplyDesktopPermissionInput) => Promise<void>
    setDefaultModel: (input: SetDefaultDesktopModelInput) => Promise<DesktopBootstrapData>
    setDefaultPermissionMode: (
      input: SetDefaultDesktopPermissionModeInput
    ) => Promise<DesktopBootstrapData>
    updateModel: (input: UpdateDesktopSessionModelInput) => Promise<DesktopSessionRecord>
    updatePermissionMode: (
      input: UpdateDesktopSessionPermissionModeInput
    ) => Promise<DesktopSessionRecord>
    rename: (input: RenameDesktopSessionInput) => Promise<DesktopSessionRecord>
    setPinned: (input: PinDesktopSessionInput) => Promise<DesktopSessionRecord>
    archive: (sessionId: string) => Promise<DesktopSessionRecord>
    delete: (sessionId: string) => Promise<string[]>
    onDaemonStatusChanged: (listener: (value: DesktopDaemonStatus) => void) => () => void
    onUpdated: (listener: (value: DesktopSessionView) => void) => () => void
    onAuxUpdated: (listener: (value: DesktopAuxSessionUpdate) => void) => () => void
  }
}
