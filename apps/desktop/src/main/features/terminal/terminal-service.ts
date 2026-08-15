import type { WebContents } from "electron"
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
    return await (await desktopSessionService.daemonClient()).createTerminal(input)
  }

  async write(webContents: WebContents, input: TerminalWriteRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await (await desktopSessionService.daemonClient()).writeTerminal(input)
  }

  async resize(webContents: WebContents, input: TerminalResizeRequest): Promise<void> {
    this.ensureSubscription(webContents)
    await (await desktopSessionService.daemonClient()).resizeTerminal(input)
  }

  async read(webContents: WebContents, input: TerminalReadRequest): Promise<TerminalReadResult> {
    this.ensureSubscription(webContents)
    return await (await desktopSessionService.daemonClient()).readTerminal(input.terminalId)
  }

  async kill(webContents: WebContents, terminalId: string): Promise<void> {
    this.ensureSubscription(webContents)
    await (await desktopSessionService.daemonClient()).closeTerminal(terminalId)
  }

  async list(webContents: WebContents): Promise<TerminalSessionInfo[]> {
    this.ensureSubscription(webContents)
    return await (await desktopSessionService.daemonClient()).listTerminals()
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
