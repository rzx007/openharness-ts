import { Folder, LayoutGrid, SquareTerminal } from "lucide-react"
import type * as React from "react"

import { cn } from "@renderer/lib/utils"
import type { WorkspaceOpener } from "@shared/workspace-types"

export function OpenerIcon({
  opener,
  compact,
}: {
  opener: WorkspaceOpener | null
  compact?: boolean
}): React.JSX.Element {
  const iconClass = compact ? "size-3" : "size-4"
  if (opener?.iconDataUrl) {
    return <img src={opener.iconDataUrl} alt="" className={cn(iconClass, "object-contain")} />
  }

  if (opener?.kind === "terminal") {
    return <SquareTerminal className={iconClass} strokeWidth={1.8} />
  }
  if (opener?.kind === "editor") {
    return <LayoutGrid className={iconClass} strokeWidth={1.8} />
  }
  return <Folder className={cn(iconClass, "text-amber-500")} strokeWidth={1.8} />
}
