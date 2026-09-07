import { useState } from "react"

import type { DesktopContextUsageSnapshot } from "@shared/context-usage-types"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"

import { ContextUsageRing } from "./context-usage-ring"
import { ContextUsageTray } from "./context-usage-tray"

export function ContextUsageControl({
  snapshot,
  onOpen,
}: {
  snapshot: DesktopContextUsageSnapshot | null
  onOpen?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
    >
      <PopoverTrigger render={<ContextUsageRing snapshot={snapshot} className="shrink-0" />} />
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-auto gap-0 rounded-xl p-2 shadow-lg ring-1 ring-black/10"
      >
        {snapshot ? (
          <ContextUsageTray snapshot={snapshot} />
        ) : (
          <div className="w-64 px-2 py-3 text-xs text-muted-foreground">正在加载上下文…</div>
        )}
      </PopoverContent>
    </Popover>
  )
}
