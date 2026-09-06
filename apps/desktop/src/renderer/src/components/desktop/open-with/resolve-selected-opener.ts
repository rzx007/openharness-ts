import type { WorkspaceOpener } from "@shared/workspace-types"

export function resolveSelectedOpener(
  openers: WorkspaceOpener[],
  selectedId: string | null
): WorkspaceOpener | null {
  if (openers.length === 0) return null
  return (
    openers.find((opener) => opener.id === selectedId) ??
    openers.find((opener) => opener.id === "cursor") ??
    openers.find((opener) => opener.id === "vscode") ??
    openers[0] ??
    null
  )
}
