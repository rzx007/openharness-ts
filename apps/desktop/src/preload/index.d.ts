import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  DesktopAppInfo,
  PetState,
  PlatformInfo,
  TrayNotificationOptions
} from '../shared/ipc-channels'

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
