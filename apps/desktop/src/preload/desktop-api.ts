import { ipcRenderer } from "electron"

import {
  IpcChannels,
  IpcEvents,
  type IpcChannel,
  type IpcInvokeMap,
  type TrayNotificationOptions,
} from "../shared/ipc-channels"
import type { DesktopTerminalEvent } from "../shared/terminal-types"
import type { DesktopAuxSessionUpdate, DesktopDaemonStatus } from "../shared/session-types"
import type { DesktopAPI } from "../shared/desktop-api-contract"

const invoke = <C extends IpcChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]["args"]
): Promise<IpcInvokeMap[C]["result"]> => ipcRenderer.invoke(channel, ...args)

export const desktopAPI = {
  app: {
    getInfo: () => invoke(IpcChannels.appGetInfo),
    getPlatform: () => invoke(IpcChannels.appGetPlatform),
    quit: () => invoke(IpcChannels.appQuit),
  },
  window: {
    showMain: () => invoke(IpcChannels.windowShowMain),
    minimize: () => invoke(IpcChannels.windowMinimize),
    close: () => invoke(IpcChannels.windowClose),
    toggleMaximize: () => invoke(IpcChannels.windowToggleMaximize),
    isMaximized: () => invoke(IpcChannels.windowIsMaximized),
    getZoomLevel: () => invoke(IpcChannels.windowGetZoomLevel),
    setZoomLevel: (level: number) => invoke(IpcChannels.windowSetZoomLevel, level),
    onMaximizedChanged: (listener: (value: boolean) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: boolean): void => listener(value)
      ipcRenderer.on(IpcEvents.windowMaximizedChanged, wrapped)
      return () => ipcRenderer.removeListener(IpcEvents.windowMaximizedChanged, wrapped)
    },
  },
  tray: {
    flash: () => invoke(IpcChannels.trayFlash),
    stopFlash: () => invoke(IpcChannels.trayStopFlash),
    notify: (options: TrayNotificationOptions) => invoke(IpcChannels.trayNotify, options),
  },
  pet: {
    show: () => invoke(IpcChannels.petShow),
    hide: () => invoke(IpcChannels.petHide),
    toggle: () => invoke(IpcChannels.petToggle),
    getState: () => invoke(IpcChannels.petGetState),
    setAlwaysOnTop: (value: boolean) => invoke(IpcChannels.petSetAlwaysOnTop, value),
    setIgnoreMouseEvents: (value: boolean) => invoke(IpcChannels.petSetIgnoreMouseEvents, value),
    onClicked: (listener: () => void): (() => void) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(IpcEvents.petClicked, wrapped)
      return () => ipcRenderer.removeListener(IpcEvents.petClicked, wrapped)
    },
  },
  workspace: {
    listFiles: (input: IpcInvokeMap[typeof IpcChannels.workspaceListFiles]["args"][0]) =>
      invoke(IpcChannels.workspaceListFiles, input),
    readFile: (input: IpcInvokeMap[typeof IpcChannels.workspaceReadFile]["args"][0]) =>
      invoke(IpcChannels.workspaceReadFile, input),
    revealPath: (input: IpcInvokeMap[typeof IpcChannels.workspaceRevealPath]["args"][0]) =>
      invoke(IpcChannels.workspaceRevealPath, input),
    copyPath: (input: IpcInvokeMap[typeof IpcChannels.workspaceCopyPath]["args"][0]) =>
      invoke(IpcChannels.workspaceCopyPath, input),
    listOpeners: () => invoke(IpcChannels.workspaceListOpeners),
    openWith: (input: IpcInvokeMap[typeof IpcChannels.workspaceOpenWith]["args"][0]) =>
      invoke(IpcChannels.workspaceOpenWith, input),
  },
  git: {
    changes: (input: IpcInvokeMap[typeof IpcChannels.gitChanges]["args"][0]) =>
      invoke(IpcChannels.gitChanges, input),
    fileDiff: (input: IpcInvokeMap[typeof IpcChannels.gitFileDiff]["args"][0]) =>
      invoke(IpcChannels.gitFileDiff, input),
  },
  clipboard: {
    readText: () => invoke(IpcChannels.clipboardReadText),
    writeText: (text: string) => invoke(IpcChannels.clipboardWriteText, text),
  },
  terminal: {
    create: (input: IpcInvokeMap[typeof IpcChannels.terminalCreate]["args"][0]) =>
      invoke(IpcChannels.terminalCreate, input),
    write: (input: IpcInvokeMap[typeof IpcChannels.terminalWrite]["args"][0]) =>
      invoke(IpcChannels.terminalWrite, input),
    resize: (input: IpcInvokeMap[typeof IpcChannels.terminalResize]["args"][0]) =>
      invoke(IpcChannels.terminalResize, input),
    read: (input: IpcInvokeMap[typeof IpcChannels.terminalRead]["args"][0]) =>
      invoke(IpcChannels.terminalRead, input),
    kill: (terminalId: string) => invoke(IpcChannels.terminalKill, terminalId),
    list: () => invoke(IpcChannels.terminalList),
    onEvent: (listener: (event: DesktopTerminalEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: DesktopTerminalEvent): void =>
        listener(value)
      ipcRenderer.on(IpcEvents.terminalData, wrapped)
      ipcRenderer.on(IpcEvents.terminalStatus, wrapped)
      ipcRenderer.on(IpcEvents.terminalExit, wrapped)
      ipcRenderer.on(IpcEvents.terminalError, wrapped)
      return () => {
        ipcRenderer.removeListener(IpcEvents.terminalData, wrapped)
        ipcRenderer.removeListener(IpcEvents.terminalStatus, wrapped)
        ipcRenderer.removeListener(IpcEvents.terminalExit, wrapped)
        ipcRenderer.removeListener(IpcEvents.terminalError, wrapped)
      }
    },
  },
  schedules: {
    status: () => invoke(IpcChannels.scheduleStatus),
    list: () => invoke(IpcChannels.scheduleList),
    create: (input: IpcInvokeMap[typeof IpcChannels.scheduleCreate]["args"][0]) =>
      invoke(IpcChannels.scheduleCreate, input),
    update: (id: string, input: IpcInvokeMap[typeof IpcChannels.scheduleUpdate]["args"][1]) =>
      invoke(IpcChannels.scheduleUpdate, id, input),
    remove: (id: string) => invoke(IpcChannels.scheduleRemove, id),
    runNow: (id: string) => invoke(IpcChannels.scheduleRunNow, id),
    listRuns: (input: IpcInvokeMap[typeof IpcChannels.scheduleListRuns]["args"][0]) =>
      invoke(IpcChannels.scheduleListRuns, input),
    setRunUnread: (id: string, unread: boolean) =>
      invoke(IpcChannels.scheduleSetRunUnread, id, unread),
  },
  providers: {
    snapshot: () => invoke(IpcChannels.providerSnapshot),
    connect: (input: IpcInvokeMap[typeof IpcChannels.providerConnect]["args"][0]) =>
      invoke(IpcChannels.providerConnect, input),
    activate: (input: IpcInvokeMap[typeof IpcChannels.providerActivate]["args"][0]) =>
      invoke(IpcChannels.providerActivate, input),
    disconnect: (input: IpcInvokeMap[typeof IpcChannels.providerDisconnect]["args"][0]) =>
      invoke(IpcChannels.providerDisconnect, input),
    createCustom: (input: IpcInvokeMap[typeof IpcChannels.providerCustomCreate]["args"][0]) =>
      invoke(IpcChannels.providerCustomCreate, input),
    updateCustom: (input: IpcInvokeMap[typeof IpcChannels.providerCustomUpdate]["args"][0]) =>
      invoke(IpcChannels.providerCustomUpdate, input),
    removeCustom: (input: IpcInvokeMap[typeof IpcChannels.providerCustomRemove]["args"][0]) =>
      invoke(IpcChannels.providerCustomRemove, input),
  },
  settings: {
    snapshot: () => invoke(IpcChannels.settingsSnapshot),
    updateWorkStyle: (input: IpcInvokeMap[typeof IpcChannels.settingsUpdateWorkStyle]["args"][0]) =>
      invoke(IpcChannels.settingsUpdateWorkStyle, input),
  },
  plugins: {
    snapshot: (input: IpcInvokeMap[typeof IpcChannels.pluginSnapshot]["args"][0]) =>
      invoke(IpcChannels.pluginSnapshot, input),
    enable: (input: IpcInvokeMap[typeof IpcChannels.pluginEnable]["args"][0]) =>
      invoke(IpcChannels.pluginEnable, input),
    disable: (input: IpcInvokeMap[typeof IpcChannels.pluginDisable]["args"][0]) =>
      invoke(IpcChannels.pluginDisable, input),
    uninstall: (input: IpcInvokeMap[typeof IpcChannels.pluginUninstall]["args"][0]) =>
      invoke(IpcChannels.pluginUninstall, input),
    reload: (input: IpcInvokeMap[typeof IpcChannels.pluginReload]["args"][0]) =>
      invoke(IpcChannels.pluginReload, input),
  },
  sessions: {
    bootstrap: () => invoke(IpcChannels.sessionBootstrap),
    daemonStatus: () => invoke(IpcChannels.sessionDaemonStatus),
    chooseProject: () => invoke(IpcChannels.sessionChooseProject),
    inspectProject: (path: string) => invoke(IpcChannels.sessionInspectProject, path),
    listCommands: (cwd: string) => invoke(IpcChannels.sessionListCommands, cwd),
    renameProject: (input: IpcInvokeMap[typeof IpcChannels.projectRename]["args"][0]) =>
      invoke(IpcChannels.projectRename, input),
    setProjectPinned: (input: IpcInvokeMap[typeof IpcChannels.projectSetPinned]["args"][0]) =>
      invoke(IpcChannels.projectSetPinned, input),
    setProjectDefaultShell: (
      input: IpcInvokeMap[typeof IpcChannels.projectSetDefaultShell]["args"][0]
    ) => invoke(IpcChannels.projectSetDefaultShell, input),
    removeProject: (path: string) => invoke(IpcChannels.projectRemove, path),
    rebindProject: (projectId: string) => invoke(IpcChannels.projectRebind, projectId),
    checkoutBranch: (input: IpcInvokeMap[typeof IpcChannels.projectCheckoutBranch]["args"][0]) =>
      invoke(IpcChannels.projectCheckoutBranch, input),
    createBranch: (input: IpcInvokeMap[typeof IpcChannels.projectCreateBranch]["args"][0]) =>
      invoke(IpcChannels.projectCreateBranch, input),
    create: (input: IpcInvokeMap[typeof IpcChannels.sessionCreate]["args"][0]) =>
      invoke(IpcChannels.sessionCreate, input),
    open: (sessionId: string) => invoke(IpcChannels.sessionOpen, sessionId),
    openAux: (input: IpcInvokeMap[typeof IpcChannels.sessionAuxOpen]["args"][0]) =>
      invoke(IpcChannels.sessionAuxOpen, input),
    closeAux: (input: IpcInvokeMap[typeof IpcChannels.sessionAuxClose]["args"][0]) =>
      invoke(IpcChannels.sessionAuxClose, input),
    fork: (input: IpcInvokeMap[typeof IpcChannels.sessionFork]["args"][0]) =>
      invoke(IpcChannels.sessionFork, input),
    close: () => invoke(IpcChannels.sessionClose),
    sendPrompt: (input: IpcInvokeMap[typeof IpcChannels.sessionSendPrompt]["args"][0]) =>
      invoke(IpcChannels.sessionSendPrompt, input),
    invokeCommand: (input: IpcInvokeMap[typeof IpcChannels.sessionInvokeCommand]["args"][0]) =>
      invoke(IpcChannels.sessionInvokeCommand, input),
    editLatestPrompt: (
      input: IpcInvokeMap[typeof IpcChannels.sessionEditLatestPrompt]["args"][0]
    ) => invoke(IpcChannels.sessionEditLatestPrompt, input),
    interrupt: (sessionId: string) => invoke(IpcChannels.sessionInterrupt, sessionId),
    replyPermission: (input: IpcInvokeMap[typeof IpcChannels.sessionReplyPermission]["args"][0]) =>
      invoke(IpcChannels.sessionReplyPermission, input),
    setDefaultModel: (input: IpcInvokeMap[typeof IpcChannels.sessionSetDefaultModel]["args"][0]) =>
      invoke(IpcChannels.sessionSetDefaultModel, input),
    setDefaultPermissionMode: (
      input: IpcInvokeMap[typeof IpcChannels.sessionSetDefaultPermissionMode]["args"][0]
    ) => invoke(IpcChannels.sessionSetDefaultPermissionMode, input),
    updateModel: (input: IpcInvokeMap[typeof IpcChannels.sessionUpdateModel]["args"][0]) =>
      invoke(IpcChannels.sessionUpdateModel, input),
    updatePermissionMode: (
      input: IpcInvokeMap[typeof IpcChannels.sessionUpdatePermissionMode]["args"][0]
    ) => invoke(IpcChannels.sessionUpdatePermissionMode, input),
    rename: (input: IpcInvokeMap[typeof IpcChannels.sessionRename]["args"][0]) =>
      invoke(IpcChannels.sessionRename, input),
    setPinned: (input: IpcInvokeMap[typeof IpcChannels.sessionSetPinned]["args"][0]) =>
      invoke(IpcChannels.sessionSetPinned, input),
    archive: (sessionId: string) => invoke(IpcChannels.sessionArchive, sessionId),
    delete: (sessionId: string) => invoke(IpcChannels.sessionDelete, sessionId),
    onDaemonStatusChanged: (listener: (value: DesktopDaemonStatus) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: DesktopDaemonStatus): void =>
        listener(value)
      ipcRenderer.on(IpcEvents.sessionDaemonStatusChanged, wrapped)
      return () => ipcRenderer.removeListener(IpcEvents.sessionDaemonStatusChanged, wrapped)
    },
    onUpdated: (
      listener: (value: IpcInvokeMap[typeof IpcChannels.sessionOpen]["result"]) => void
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        value: IpcInvokeMap[typeof IpcChannels.sessionOpen]["result"]
      ): void => listener(value)
      ipcRenderer.on(IpcEvents.sessionUpdated, wrapped)
      return () => ipcRenderer.removeListener(IpcEvents.sessionUpdated, wrapped)
    },
    onAuxUpdated: (listener: (value: DesktopAuxSessionUpdate) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: DesktopAuxSessionUpdate): void =>
        listener(value)
      ipcRenderer.on(IpcEvents.sessionAuxUpdated, wrapped)
      return () => ipcRenderer.removeListener(IpcEvents.sessionAuxUpdated, wrapped)
    },
  },
} satisfies DesktopAPI
