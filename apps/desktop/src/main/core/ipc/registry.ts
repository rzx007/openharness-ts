import { ipcMain } from 'electron'

import type { AppContext } from '../app-context'
import type { IpcContribution } from './types'
import { wrapIpcHandler } from './wrap-handler'

export class IpcRegistry {
  private readonly registered = new Map<string, string>()

  constructor(private readonly ctx: AppContext) {}

  register(contribution: IpcContribution): void {
    for (const { channel, handler } of contribution.register(this.ctx)) {
      if (this.registered.has(channel)) {
        console.warn(
          `[ipc] channel "${channel}" already registered by ${this.registered.get(channel)}`
        )
        continue
      }

      ipcMain.handle(channel, wrapIpcHandler(contribution.id, channel, handler))
      this.registered.set(channel, contribution.id)
    }
  }

  dispose(): void {
    for (const channel of this.registered.keys()) {
      ipcMain.removeHandler(channel)
    }
    this.registered.clear()
  }
}
