import { ipcRenderer } from 'electron'

import {
  IpcChannels,
  type IpcChannel,
  type IpcInvokeMap,
  type TrayNotificationOptions
} from '../shared/ipc-channels'

const invoke = <C extends IpcChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> => ipcRenderer.invoke(channel, ...args)

export const desktopAPI = {
  app: {
    getInfo: () => invoke(IpcChannels.appGetInfo),
    getPlatform: () => invoke(IpcChannels.appGetPlatform),
    quit: () => invoke(IpcChannels.appQuit)
  },
  window: {
    showMain: () => invoke(IpcChannels.windowShowMain),
    minimize: () => invoke(IpcChannels.windowMinimize),
    close: () => invoke(IpcChannels.windowClose),
    toggleMaximize: () => invoke(IpcChannels.windowToggleMaximize),
    isMaximized: () => invoke(IpcChannels.windowIsMaximized),
    onMaximizedChanged: (listener: (value: boolean) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: boolean) => listener(value)
      ipcRenderer.on('window:maximized-changed', wrapped)
      return () => ipcRenderer.removeListener('window:maximized-changed', wrapped)
    }
  },
  tray: {
    flash: () => invoke(IpcChannels.trayFlash),
    stopFlash: () => invoke(IpcChannels.trayStopFlash),
    notify: (options: TrayNotificationOptions) => invoke(IpcChannels.trayNotify, options)
  },
  pet: {
    show: () => invoke(IpcChannels.petShow),
    hide: () => invoke(IpcChannels.petHide),
    toggle: () => invoke(IpcChannels.petToggle),
    getState: () => invoke(IpcChannels.petGetState),
    setAlwaysOnTop: (value: boolean) => invoke(IpcChannels.petSetAlwaysOnTop, value),
    setIgnoreMouseEvents: (value: boolean) =>
      invoke(IpcChannels.petSetIgnoreMouseEvents, value)
  },
  events: {
    onMainProcessMessage: (listener: (message: string) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message)
      ipcRenderer.on('main-process-message', wrapped)
      return () => ipcRenderer.removeListener('main-process-message', wrapped)
    }
  }
}

export type DesktopAPI = typeof desktopAPI
