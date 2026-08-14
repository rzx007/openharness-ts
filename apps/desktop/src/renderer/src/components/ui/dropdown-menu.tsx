import { Menu } from "@base-ui/react/menu"
import type { ComponentProps } from "react"

import { cn } from "@renderer/lib/utils"

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger

export function DropdownMenuContent({
  className,
  sideOffset = 5,
  align = "start",
  ...props
}: ComponentProps<typeof Menu.Popup> & {
  sideOffset?: number
  align?: ComponentProps<typeof Menu.Positioner>["align"]
}): React.JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={sideOffset} align={align} className="z-50 outline-none">
        <Menu.Popup
          className={cn(
            "min-w-44 rounded-md border border-border/80 bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: ComponentProps<typeof Menu.Item> & { destructive?: boolean }): React.JSX.Element {
  return (
    <Menu.Item
      className={cn(
        "flex h-8 cursor-default select-none items-center gap-2 rounded px-2 text-[12.5px] outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:size-3.5",
        destructive && "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive",
        className
      )}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({ className }: { className?: string }): React.JSX.Element {
  return <div role="separator" className={cn("-mx-1 my-1 h-px bg-border/80", className)} />
}
