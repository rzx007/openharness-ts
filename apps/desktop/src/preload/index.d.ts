import { ElectronAPI } from "@electron-toolkit/preload"
import type * as React from "react"
import type {
  DesktopAppInfo,
  PetState,
  PlatformInfo,
  TrayNotificationOptions,
} from "../shared/ipc-channels"
import type {
  CheckoutDesktopProjectBranchInput,
  CreateDesktopSessionInput,
  CreateDesktopProjectBranchInput,
  DesktopBootstrapData,
  DesktopProjectDetails,
  DesktopSessionRecord,
  DesktopSessionView,
  EditLatestDesktopPromptInput,
  ForkDesktopSessionInput,
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
} from "../shared/session-types"
import type {
  WorkspaceListFilesInput,
  WorkspaceListFilesResult,
  WorkspaceCopyPathInput,
  WorkspaceReadFileInput,
  WorkspaceReadFileResult,
  WorkspaceRevealPathInput,
  WorkspaceOpenWithInput,
  WorkspaceOpener,
} from "../shared/workspace-types"
import type {
  DesktopTerminalCreateInput,
  DesktopTerminalEvent,
  DesktopTerminalReadInput,
  DesktopTerminalReadResult,
  DesktopTerminalRecord,
  DesktopTerminalResizeInput,
  DesktopTerminalWriteInput,
} from "../shared/terminal-types"

export interface DesktopAPI {
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
  sessions: {
    bootstrap: () => Promise<DesktopBootstrapData>
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
    onUpdated: (listener: (value: DesktopSessionView) => void) => () => void
  }
  events: {
    onMainProcessMessage: (listener: (message: string) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    desktop: DesktopAPI
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: string
        autosize?: string
        disableblinkfeatures?: string
        httpreferrer?: string
        partition?: string
        preload?: string
        src?: string
        useragent?: string
        webpreferences?: string
      }
    }
  }
}
