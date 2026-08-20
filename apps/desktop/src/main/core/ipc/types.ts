import type { IpcMainInvokeEvent } from "electron"

import type { IpcChannel } from "../../../shared/ipc-channels"
import type { AppContext } from "../app-context"

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export interface IpcHandlerRegistration {
  channel: IpcChannel
  handler: IpcHandler
}

export interface IpcContribution {
  readonly id: string
  register(ctx: AppContext): IpcHandlerRegistration[]
}
