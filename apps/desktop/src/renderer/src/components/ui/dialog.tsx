import { Dialog } from "@base-ui/react/dialog"
import type { ComponentProps } from "react"

import { cn } from "@renderer/lib/utils"

export const DialogRoot = Dialog.Root
export const DialogTitle = Dialog.Title
export const DialogDescription = Dialog.Description
export const DialogClose = Dialog.Close

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Dialog.Popup>): React.JSX.Element {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px] transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/45" />
      <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
        <Dialog.Popup
          className={cn(
            "w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-2xl outline-none transition-[opacity,transform] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  )
}
