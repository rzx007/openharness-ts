import type { WebContents } from "electron"
import type { OpenHarnessClient } from "@openharness/client"
import type {
  TerminalCreateRequest,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalWriteRequest,
} from "@openharness/terminal"

import { IpcEvents } from "../../../shared/ipc-channels"
import { desktopSessionService } from "../session/session-service"

interface TerminalSubscription {
  controller: AbortController
}

class DesktopTerminalService {
  private readonly subscriptions = new Map<number, TerminalSubscription>()

  async create(
    webContents: WebContents,
    input: TerminalCreateRequest
  ): Promise<TerminalSessionInfo> {
    this.ensureSubscription(webContents)
    return await withDaemonRetry((client) => client.createTerminal(input))
  }

  async write(webContents: WebContents, input: TerminalWriteRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.writeTerminal(input))
  }

  async resize(webContents: WebContents, input: TerminalResizeRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.resizeTerminal(input))
  }

  async read(webContents: WebContents, input: TerminalReadRequest): Promise<TerminalReadResult> {
    this.ensureSubscription(webContents)
    return await withDaemonRetry((client) => client.readTerminal(input.terminalId))
  }

  async kill(webContents: WebContents, terminalId: string): Promise<void> {
    this.ensureSubscription(webContents)
    await withDaemonRetry((client) => client.closeTerminal(terminalId))
  }

  async list(webContents: WebContents): Promise<TerminalSessionInfo[]> {
    this.ensureSubscription(webContents)
    return await withDaemonRetry((client) => client.listTerminals())
  }

  async dispose(): Promise<void> {
    for (const subscription of this.subscriptions.values()) subscription.controller.abort()
    this.subscriptions.clear()
  }

  private ensureSubscription(webContents: WebContents): void {
    if (this.subscriptions.has(webContents.id)) return
    const controller = new AbortController()
    this.subscriptions.set(webContents.id, { controller })
    webContents.once("destroyed", () => {
      controller.abort()
      this.subscriptions.delete(webContents.id)
    })
    void this.pumpEvents(webContents, controller)
  }

  private async pumpEvents(webContents: WebContents, controller: AbortController): Promise<void> {
    try {
      const client = await desktopSessionService.daemonClient()
      for await (const event of client.streamTerminalEvents({ signal: controller.signal })) {
        if (controller.signal.aborted || webContents.isDestroyed()) return
        if (event.type === "data") webContents.send(IpcEvents.terminalData, event)
        else if (event.type === "exit") webContents.send(IpcEvents.terminalExit, event)
        else if (event.type === "error") webContents.send(IpcEvents.terminalError, event)
      }
    } catch (error) {
      if (!controller.signal.aborted && !webContents.isDestroyed()) {
        console.error("[terminal] event stream failed", error)
      }
    }
  }
}

export const desktopTerminalService = new DesktopTerminalService()

async function withDaemonRetry<T>(operation: (client: OpenHarnessClient) => Promise<T>): Promise<T> {
  try {
    return await operation(await desktopSessionService.daemonClient())
  } catch (error) {
    if (!shouldRefreshDaemonClient(error)) throw error
    return await operation(await desktopSessionService.refreshDaemonClient())
  }
}

function shouldRefreshDaemonClient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes("Failed to fetch") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("Cannot find module './prebuilds") ||
    message.includes("Failed to load native module: conpty.node")
  )
}
