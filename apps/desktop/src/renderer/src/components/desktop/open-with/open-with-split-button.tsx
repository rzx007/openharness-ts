import { ChevronDown } from "lucide-react"
import type * as React from "react"
import { useState } from "react"

import { OpenerIcon } from "@renderer/components/desktop/open-with/opener-icon"
import {
  launchWorkspaceOpener,
  useWorkspaceOpeners,
} from "@renderer/components/desktop/open-with/use-workspace-openers"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { cn } from "@renderer/lib/utils"

export function OpenWithSplitButton({
  folderPath,
}: {
  folderPath: string | null | undefined
}): React.JSX.Element {
  const { openers, selected } = useWorkspaceOpeners()
  const [opening, setOpening] = useState(false)
  const disabled = !folderPath || !selected || opening

  const openWith = async (openerId: string): Promise<void> => {
    if (!folderPath || opening) return
    setOpening(true)
    try {
      await launchWorkspaceOpener({ openerId, path: folderPath, persist: true })
    } catch {
      // Launch failures are surfaced by the OS; keep the selected opener.
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex h-7 shrink-0 overflow-hidden rounded-full border border-border/40 bg-background">
      <button
        type="button"
        disabled={disabled}
        title={selected && folderPath ? `用 ${selected.label} 打开 ${folderPath}` : "选择打开方式"}
        onClick={() => selected && void openWith(selected.id)}
        className="grid w-7.5 place-items-center text-ui-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
      >
        <OpenerIcon opener={selected} compact />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={!folderPath || openers.length === 0}
          aria-label="选择打开方式"
          title="其他打开方式"
          className="grid w-6 place-items-center text-ui-muted transition-colors outline-none hover:bg-muted hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 data-[popup-open]:bg-muted data-[popup-open]:text-ui-foreground [&_svg]:size-3"
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {openers.map((opener) => (
            <DropdownMenuItem
              key={opener.id}
              onClick={() => void openWith(opener.id)}
              className={cn(opener.id === selected?.id && "bg-muted/70")}
            >
              <OpenerIcon opener={opener} />
              {opener.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
