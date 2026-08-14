import type { IpcMainInvokeEvent } from 'electron'

import type { AppContext } from '../app-context'

export type IpcHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown

export interface IpcHandlerRegistration {
  channel: string
  handler: IpcHandler
}

export interface IpcContribution {
  readonly id: string
  register(ctx: AppContext): IpcHandlerRegistration[]
}
