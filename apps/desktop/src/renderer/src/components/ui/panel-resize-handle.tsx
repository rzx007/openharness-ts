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
        "relative z-40 w-px bg-transparent outline-none after:pointer-events-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:content-['']",
        "after:bg-linear-to-b after:from-transparent after:via-border after:to-transparent",
        "hover:after:via-primary focus-visible:after:via-primary data-[separator=active]:after:via-primary",
        className
      )}
    />
  )
}
