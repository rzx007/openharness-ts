import { ipcRenderer } from "electron"

import {
  IpcChannels,
  IpcEvents,
  type IpcChannel,
  type IpcInvokeMap,
  type TrayNotificationOptions,
} from "../shared/ipc-channels"

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
    onMaximizedChanged: (listener: (value: boolean) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: boolean): void => listener(value)
      ipcRenderer.on("window:maximized-changed", wrapped)
      return () => ipcRenderer.removeListener("window:maximized-changed", wrapped)
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
  },
  sessions: {
    bootstrap: () => invoke(IpcChannels.sessionBootstrap),
    chooseProject: () => invoke(IpcChannels.sessionChooseProject),
    inspectProject: (path: string) => invoke(IpcChannels.sessionInspectProject, path),
    create: (input: IpcInvokeMap[typeof IpcChannels.sessionCreate]["args"][0]) =>
      invoke(IpcChannels.sessionCreate, input),
    open: (sessionId: string) => invoke(IpcChannels.sessionOpen, sessionId),
    close: () => invoke(IpcChannels.sessionClose),
    sendPrompt: (input: IpcInvokeMap[typeof IpcChannels.sessionSendPrompt]["args"][0]) =>
      invoke(IpcChannels.sessionSendPrompt, input),
    interrupt: (sessionId: string) => invoke(IpcChannels.sessionInterrupt, sessionId),
    replyPermission: (input: IpcInvokeMap[typeof IpcChannels.sessionReplyPermission]["args"][0]) =>
      invoke(IpcChannels.sessionReplyPermission, input),
    rename: (input: IpcInvokeMap[typeof IpcChannels.sessionRename]["args"][0]) =>
      invoke(IpcChannels.sessionRename, input),
    setPinned: (input: IpcInvokeMap[typeof IpcChannels.sessionSetPinned]["args"][0]) =>
      invoke(IpcChannels.sessionSetPinned, input),
    archive: (sessionId: string) => invoke(IpcChannels.sessionArchive, sessionId),
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
  },
  events: {
    onMainProcessMessage: (listener: (message: string) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string): void => listener(message)
      ipcRenderer.on("main-process-message", wrapped)
      return () => ipcRenderer.removeListener("main-process-message", wrapped)
    },
  },
}

export type DesktopAPI = typeof desktopAPI
