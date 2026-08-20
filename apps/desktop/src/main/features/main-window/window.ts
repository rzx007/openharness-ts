import { BrowserWindow, shell, type WebPreferences } from "electron"

import { IpcEvents } from "../../../shared/ipc-channels"
import type { AppContext } from "../../core/app-context"
import { isForceQuit } from "../../core/services/lifecycle"
import { showPetWindow, syncPetWithMainWindow } from "../pet/window"

export function createMainWindow(ctx: AppContext): BrowserWindow {
  const existing = ctx.windowManager.getMain()
  if (existing) {
    showMainWindow(existing)
    return existing
  }

  const mainWindow = ctx.windowManager.createWindow({
    id: "main",
    route: "/",
    paths: ctx.paths,
    options: {
      width: 1180,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      title: "OpenHarness",
      autoHideMenuBar: true,
      frame: false,
      backgroundColor: "#f4f7f9",
      webPreferences: {
        webviewTag: true,
      },
    },
    onCreated: (win) => {
      attachMainWindowBehavior(ctx, win)
      attachMainWindowDiagnostics(win)
    },
  })

  return mainWindow
}

export function showMainWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function attachMainWindowBehavior(ctx: AppContext, win: BrowserWindow): void {
  attachWebviewPolicy(win)

  win.once("ready-to-show", () => {
    showMainWindow(win)
  })

  win.on("close", (event) => {
    if (isForceQuit()) return

    event.preventDefault()
    win.hide()
    showPetWindow(ctx)
  })

  win.on("minimize", () => {
    showPetWindow(ctx)
  })

  win.on("restore", () => {
    syncPetWithMainWindow(ctx, win)
  })

  win.on("show", () => {
    syncPetWithMainWindow(ctx, win)
  })

  win.on("maximize", () => {
    win.webContents.send(IpcEvents.windowMaximizedChanged, true)
  })

  win.on("unmaximize", () => {
    win.webContents.send(IpcEvents.windowMaximizedChanged, false)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      void shell.openExternal(url)
    }

    return { action: "deny" }
  })
}

function attachWebviewPolicy(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!isAllowedWebviewUrl(params.src)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.sandbox = true
    ;(webPreferences as WebPreferences & { javascript?: boolean }).javascript = true
    params.partition = "persist:openharness-browser"
  })
}

function isAllowedWebviewUrl(value: string | undefined): boolean {
  if (!value) return true
  if (value === "about:blank") return true
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
  } catch {
    return false
  }
}

function attachMainWindowDiagnostics(win: BrowserWindow): void {
  let recoveryCount = 0

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main-window] renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.getURL(),
      recoveryCount,
    })

    if (win.isDestroyed() || recoveryCount >= 2) return
    recoveryCount += 1
    setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.reload()
    }, 500).unref()
  })

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      console.error("[main-window] failed to load", {
        errorCode,
        errorDescription,
        validatedURL,
      })
    }
  )

  win.on("unresponsive", () => {
    console.warn("[main-window] unresponsive")
  })

  win.on("responsive", () => {
    console.info("[main-window] responsive")
  })
}
