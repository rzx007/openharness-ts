import type { IpcContribution } from '../core/ipc/types'
import { petIpcContribution } from './pet/ipc'
import { sessionIpcContribution } from './session/ipc'
import { terminalIpcContribution } from './terminal/ipc'
import { trayIpcContribution } from './tray/ipc'
import { windowControlsIpcContribution } from './window-controls/ipc'
import { workspaceIpcContribution } from './workspace/ipc'

export const allIpcContributions: IpcContribution[] = [
  windowControlsIpcContribution,
  trayIpcContribution,
  petIpcContribution,
  sessionIpcContribution,
  terminalIpcContribution,
  workspaceIpcContribution
]
