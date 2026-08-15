export interface DesktopProject {
  id: string
  name: string
  path: string
  lastOpenedAt: number
  pinnedAt?: number
  available: boolean
}

export interface DesktopModel {
  id: string
  label: string
  provider: string
  providerName: string
  hint?: string
  contextWindow?: number
  outputLimit?: number
  reasoning?: boolean
  vision?: boolean
  toolCalling?: boolean
  status?: "active" | "beta"
}

export interface DesktopSessionRecord {
  id: string
  parentId?: string
  projectId?: string
  cwd: string
  cwdRelative?: string
  title: string
  model: string
  agent?: string
  status: "idle" | "running" | "closing" | "archived" | "error"
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
  archivedAt?: number
}

export interface DesktopSessionInput {
  id: string
  sessionId: string
  seq: number
  delivery: "queue" | "steer"
  content: string
  promotedMessageId?: string
  metadata: Record<string, unknown>
  createdAt: number
}

export interface DesktopSessionMessage {
  id: string
  sessionId: string
  seq: number
  role: "system" | "user" | "assistant"
  runId?: string
  inputId?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DesktopSessionPart {
  id: string
  sessionId: string
  messageId: string
  seq: number
  type: "text" | "reasoning" | "tool" | "tool_result" | "error" | "log"
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  text?: string
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  output?: unknown
  isError?: boolean
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DesktopSessionRun {
  id: string
  sessionId: string
  inputId?: string
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  startedAt?: number
  finishedAt?: number
  error?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface DesktopSessionTask {
  id: string
  sessionId: string
  childSessionId?: string
  runId?: string
  type: string
  status: "pending" | "running" | "completed" | "failed" | "stopped" | "interrupted"
  description: string
  cwd: string
  output?: string
  error?: string
  metadata: Record<string, unknown>
  createdAt: number
  startedAt?: number
  finishedAt?: number
  updatedAt: number
}

export interface DesktopPermissionRequest {
  id: string
  sessionId: string
  runId?: string
  toolName: string
  payload: Record<string, unknown>
  status: "pending" | "approved" | "denied" | "expired"
  decision?: string
  decidedByClientId?: string
  createdAt: number
  updatedAt: number
}

export type DesktopPermissionMode = "default" | "plan" | "full_auto"

export interface DesktopBootstrapData {
  connected: true
  projects: DesktopProject[]
  sessions: DesktopSessionRecord[]
  archivedSessions: DesktopSessionRecord[]
  models: DesktopModel[]
  defaultModel: string
  defaultProvider?: string
  defaultPermissionMode: DesktopPermissionMode
}

export interface DesktopProjectDetails {
  project: DesktopProject
  branch: string | null
}

export type DesktopSessionSyncStatus = "connected" | "reconnecting"

export interface DesktopSessionView {
  cursor: number
  syncStatus: DesktopSessionSyncStatus
  session: DesktopSessionRecord
  inputs: DesktopSessionInput[]
  messages: DesktopSessionMessage[]
  parts: DesktopSessionPart[]
  runs: DesktopSessionRun[]
  tasks: DesktopSessionTask[]
  permissions: DesktopPermissionRequest[]
}

export interface CreateDesktopSessionInput {
  projectId: string
  cwd: string
  model: string
  provider?: string
  permissionMode?: DesktopPermissionMode
}

export interface SendDesktopPromptInput {
  sessionId: string
  content: string
}

export interface RenameDesktopSessionInput {
  sessionId: string
  title: string
}

export interface PinDesktopSessionInput {
  sessionId: string
  pinned: boolean
}

export interface RenameDesktopProjectInput {
  projectId: string
  name: string
}

export interface PinDesktopProjectInput {
  projectId: string
  pinned: boolean
}

export interface ReplyDesktopPermissionInput {
  permissionId: string
  status: "approved" | "denied"
  decision?: "once" | "session"
}

export interface SetDefaultDesktopModelInput {
  model: string
  provider?: string
}

export interface SetDefaultDesktopPermissionModeInput {
  permissionMode: DesktopPermissionMode
}

export interface UpdateDesktopSessionModelInput {
  sessionId: string
  model: string
  provider?: string
}

export interface UpdateDesktopSessionPermissionModeInput {
  sessionId: string
  permissionMode: DesktopPermissionMode
}
