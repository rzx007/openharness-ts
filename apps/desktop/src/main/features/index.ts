import type { IpcContribution } from "../core/ipc/types"
import { clipboardIpcContribution } from "./clipboard/ipc"
import { gitIpcContribution } from "./git/ipc"
import { petIpcContribution } from "./pet/ipc"
import { pluginIpcContribution } from "./plugin/ipc"
import { providerIpcContribution } from "./provider/ipc"
import { sessionIpcContribution } from "./session/ipc"
import { scheduleIpcContribution } from "./schedule/ipc"
import { terminalIpcContribution } from "./terminal/ipc"
import { trayIpcContribution } from "./tray/ipc"
import { windowControlsIpcContribution } from "./window-controls/ipc"
import { workspaceIpcContribution } from "./workspace/ipc"

export const allIpcContributions: IpcContribution[] = [
  windowControlsIpcContribution,
  trayIpcContribution,
  petIpcContribution,
  pluginIpcContribution,
  providerIpcContribution,
  clipboardIpcContribution,
  gitIpcContribution,
  sessionIpcContribution,
  scheduleIpcContribution,
  terminalIpcContribution,
  workspaceIpcContribution,
]
