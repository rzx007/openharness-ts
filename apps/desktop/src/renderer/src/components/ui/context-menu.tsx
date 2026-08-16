import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu"
import type { ComponentProps } from "react"

import { cn } from "@renderer/lib/utils"

export const ContextMenu = BaseContextMenu.Root
export const ContextMenuTrigger = BaseContextMenu.Trigger

export function ContextMenuContent({
  className,
  sideOffset = 4,
  align = "start",
  ...props
}: ComponentProps<typeof BaseContextMenu.Popup> & {
  sideOffset?: number
  align?: ComponentProps<typeof BaseContextMenu.Positioner>["align"]
}): React.JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner
        sideOffset={sideOffset}
        align={align}
        className="z-[90] outline-none"
      >
        <BaseContextMenu.Popup
          className={cn(
            "min-w-44 rounded-md border border-border/80 bg-popover p-1 text-popover-foreground shadow-lg transition-[opacity,transform] outline-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

export function ContextMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof BaseContextMenu.Item> & { destructive?: boolean }): React.JSX.Element {
  return (
    <BaseContextMenu.Item
      className={cn(
        "flex h-8 cursor-default items-center gap-2 rounded px-2 text-[12.5px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-3.5",
        destructive &&
          "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

export function ContextMenuSeparator({ className }: { className?: string }): React.JSX.Element {
  return <BaseContextMenu.Separator className={cn("-mx-1 my-1 h-px bg-border/80", className)} />
}
