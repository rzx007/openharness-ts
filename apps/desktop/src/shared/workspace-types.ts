export interface WorkspaceListFilesInput {
  rootPath: string
}

export interface WorkspaceFileEntry {
  path: string
  type: "file" | "directory"
  size?: number
}

export interface WorkspaceListFilesResult {
  rootPath: string
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

export interface WorkspaceReadFileInput {
  rootPath: string
  path: string
}

export interface WorkspaceReadFileResult {
  path: string
  name: string
  language: string
  size: number
  binary: boolean
  content: string | null
}

export interface WorkspaceRevealPathInput {
  rootPath: string
  path: string
}

export interface WorkspaceCopyPathInput {
  rootPath: string
  path: string
  absolute?: boolean
}

export type WorkspaceOpenerKind = "editor" | "folder" | "terminal"

export interface WorkspaceOpener {
  id: string
  label: string
  kind: WorkspaceOpenerKind
  iconDataUrl: string | null
}

export interface WorkspaceOpenWithInput {
  openerId: string
  path: string
  rootPath?: string
}
