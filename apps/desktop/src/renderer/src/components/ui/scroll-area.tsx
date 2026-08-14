import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"
import * as React from "react"

import { cn } from "@renderer/lib/utils"

type ScrollAreaProps = React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  horizontal?: boolean
  viewportClassName?: string
  contentClassName?: string
  viewportRef?: React.Ref<HTMLDivElement>
}

function ScrollArea({
  className,
  horizontal = true,
  viewportClassName,
  contentClassName,
  viewportRef,
  children,
  ...props
}: ScrollAreaProps): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className={cn(
          "h-full w-full overscroll-contain focus-visible:outline-none",
          viewportClassName
        )}
      >
        <ScrollAreaPrimitive.Content
          data-slot="scroll-area-content"
          className={cn("min-w-full", contentClassName)}
          style={horizontal ? undefined : { width: "100%", minWidth: "100%" }}
        >
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        data-slot="scroll-area-scrollbar"
        orientation="vertical"
        className={cn(
          "pointer-events-none absolute top-1 right-0.5 bottom-1 z-30 flex w-2.5 justify-center rounded-full opacity-0 transition-opacity duration-200",
          "data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-75"
        )}
      >
        <ScrollAreaPrimitive.Thumb
          data-slot="scroll-area-thumb"
          className="w-1.5 rounded-full bg-foreground/16 transition-colors hover:bg-foreground/24"
        />
      </ScrollAreaPrimitive.Scrollbar>
      {horizontal ? (
        <ScrollAreaPrimitive.Scrollbar
          data-slot="scroll-area-scrollbar"
          orientation="horizontal"
          className={cn(
            "pointer-events-none absolute right-1 bottom-0.5 left-1 z-30 flex h-2.5 items-center rounded-full opacity-0 transition-opacity duration-200",
            "data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100 data-scrolling:duration-75"
          )}
        >
          <ScrollAreaPrimitive.Thumb
            data-slot="scroll-area-thumb"
            className="h-1.5 rounded-full bg-foreground/16 transition-colors hover:bg-foreground/24"
          />
        </ScrollAreaPrimitive.Scrollbar>
      ) : null}
    </ScrollAreaPrimitive.Root>
  )
}

export { ScrollArea }
