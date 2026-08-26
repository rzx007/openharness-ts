import type { DesktopPermissionMode } from "@shared/session-types"

export type ConversationPaneProps = {
  panelOpen: boolean
  onTogglePanel: () => void
  onOpenFile: (path: string, line?: number) => void
  onOpenReview: (path?: string) => void
  onOpenTerminal: (terminalId: string) => void
  onOpenAgents: () => void
}

export interface AddToComposerEventDetail {
  text: string
}

export type LoadStatus = "idle" | "loading" | "ready" | "error"

export type StartPicker = "project" | "runtime" | "branch"

export type PermissionModeOption = {
  value: DesktopPermissionMode
  label: string
  description: string
}
