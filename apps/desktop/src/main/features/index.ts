import type { IpcContribution } from '../core/ipc/types'
import { petIpcContribution } from './pet/ipc'
import { trayIpcContribution } from './tray/ipc'
import { windowControlsIpcContribution } from './window-controls/ipc'

export const allIpcContributions: IpcContribution[] = [
  windowControlsIpcContribution,
  trayIpcContribution,
  petIpcContribution
]
