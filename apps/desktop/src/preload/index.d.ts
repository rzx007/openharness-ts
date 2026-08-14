import { ElectronAPI } from "@electron-toolkit/preload"
import type {
  DesktopAppInfo,
  PetState,
  PlatformInfo,
  TrayNotificationOptions,
} from "../shared/ipc-channels"
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
} from "../shared/session-types"

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
  sessions: {
    bootstrap: () => Promise<DesktopBootstrapData>
    chooseProject: () => Promise<DesktopProjectDetails | null>
    inspectProject: (path: string) => Promise<DesktopProjectDetails>
    renameProject: (input: RenameDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    setProjectPinned: (input: PinDesktopProjectInput) => Promise<DesktopProjectDetails["project"]>
    removeProject: (path: string) => Promise<void>
    create: (input: CreateDesktopSessionInput) => Promise<DesktopSessionRecord>
    open: (sessionId: string) => Promise<DesktopSessionView>
    close: () => Promise<void>
    sendPrompt: (input: SendDesktopPromptInput) => Promise<void>
    interrupt: (sessionId: string) => Promise<void>
    replyPermission: (input: ReplyDesktopPermissionInput) => Promise<void>
    rename: (input: RenameDesktopSessionInput) => Promise<DesktopSessionRecord>
    setPinned: (input: PinDesktopSessionInput) => Promise<DesktopSessionRecord>
    archive: (sessionId: string) => Promise<DesktopSessionRecord>
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
}
