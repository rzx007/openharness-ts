import { join } from 'path'

import type { BrowserWindow } from 'electron'

import type { WindowManager } from './services/window-manager'

export interface RuntimePaths {
  readonly mainDirname: string
  readonly rendererUrl?: string
  readonly indexHtml: string
  readonly preloadPath: string
  readonly iconPath: string
}

export interface AppContext {
  readonly paths: RuntimePaths
  readonly windowManager: WindowManager
  createMainWindow: () => BrowserWindow
}

export interface CreateAppContextOptions {
  mainDirname: string
  rendererUrl?: string
  iconPath: string
  windowManager: WindowManager
  createMainWindow: () => BrowserWindow
}

export function createRuntimePaths(options: {
  mainDirname: string
  rendererUrl?: string
  iconPath: string
}): RuntimePaths {
  return {
    mainDirname: options.mainDirname,
    rendererUrl: options.rendererUrl,
    indexHtml: join(options.mainDirname, '../renderer/index.html'),
    preloadPath: join(options.mainDirname, '../preload/index.js'),
    iconPath: options.iconPath
  }
}

export function createAppContext(options: CreateAppContextOptions): AppContext {
  return {
    paths: createRuntimePaths(options),
    windowManager: options.windowManager,
    createMainWindow: options.createMainWindow
  }
}
