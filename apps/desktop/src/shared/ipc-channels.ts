export const IpcChannels = {
  appGetInfo: 'app:get-info',
  appGetPlatform: 'app:get-platform',
  appQuit: 'app:quit',

  windowShowMain: 'window:show-main',
  windowMinimize: 'window:minimize',
  windowClose: 'window:close',
  windowToggleMaximize: 'window:toggle-maximize',
  windowIsMaximized: 'window:is-maximized',

  trayFlash: 'tray:flash',
  trayStopFlash: 'tray:stop-flash',
  trayNotify: 'tray:notify',

  petShow: 'pet:show',
  petHide: 'pet:hide',
  petToggle: 'pet:toggle',
  petGetState: 'pet:get-state',
  petSetAlwaysOnTop: 'pet:set-always-on-top',
  petSetIgnoreMouseEvents: 'pet:set-ignore-mouse-events'
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
}

export type IpcResult<C extends IpcChannel> = IpcInvokeMap[C]['result']
