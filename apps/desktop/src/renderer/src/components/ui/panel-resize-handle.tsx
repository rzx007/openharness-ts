import { Separator } from "react-resizable-panels"

import { cn } from "@renderer/lib/utils"

type PanelResizeHandleProps = {
  label: string
  className?: string
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>
}

export function PanelResizeHandle({
  label,
  className,
  onPointerDown,
}: PanelResizeHandleProps): React.JSX.Element {
  return (
    <Separator
      aria-label={label}
      onPointerDown={onPointerDown}
      className={cn(
        "relative z-40 w-px bg-transparent outline-none after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 after:content-['']",
        "hover:after:bg-foreground/16 focus-visible:after:bg-ring/70 data-[separator=active]:after:bg-foreground/28",
        className
      )}
    />
  )
}
