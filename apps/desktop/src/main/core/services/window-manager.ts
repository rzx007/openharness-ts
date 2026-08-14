import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'

import type { RuntimePaths } from '../app-context'

export type WindowId = 'main' | 'pet'

export interface WindowDescriptor {
  id: WindowId
  route: string
  paths: RuntimePaths
  options: BrowserWindowConstructorOptions
  onCreated?: (win: BrowserWindow) => void
}

export class WindowManager {
  private readonly windows = new Map<WindowId, BrowserWindow>()

  set(id: WindowId, win: BrowserWindow | null): void {
    if (!win || win.isDestroyed()) {
      this.windows.delete(id)
      return
    }

    this.windows.set(id, win)
  }

  get(id: WindowId): BrowserWindow | null {
    const win = this.windows.get(id)
    if (!win || win.isDestroyed()) {
      this.windows.delete(id)
      return null
    }

    return win
  }

  getMain(): BrowserWindow | null {
    return this.get('main')
  }

  createWindow(descriptor: WindowDescriptor): BrowserWindow {
    const win = new BrowserWindow({
      icon: descriptor.paths.iconPath,
      show: false,
      ...descriptor.options,
      webPreferences: {
        preload: descriptor.paths.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
        ...descriptor.options.webPreferences
      }
    })

    win.on('closed', () => {
      this.set(descriptor.id, null)
    })

    this.set(descriptor.id, win)
    descriptor.onCreated?.(win)
    loadRendererRoute(win, descriptor.paths, descriptor.route)
    return win
  }
}

function loadRendererRoute(win: BrowserWindow, paths: RuntimePaths, route: string): void {
  const hash = route.startsWith('/') ? route : `/${route}`

  if (paths.rendererUrl) {
    const url = new URL(paths.rendererUrl)
    url.hash = hash
    void win.loadURL(url.toString())
    return
  }

  void win.loadFile(paths.indexHtml, { hash })
}
