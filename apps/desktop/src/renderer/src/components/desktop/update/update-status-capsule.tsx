import { X } from "lucide-react"

import { cn } from "@renderer/lib/utils"
import type { DesktopUpdateState } from "@shared/update-types"

import { useDesktopUpdateState } from "./use-desktop-update-state"

export function UpdateStatusCapsule(): React.JSX.Element | null {
  const { state, visible, download, install, dismiss } = useDesktopUpdateState()
  if (!visible) return null

  const label = labelFor(state)
  const action = actionFor(state, download, install)

  return (
    <div className="flex h-full items-center pr-1">
      <div
        className={cn(
          "text-ui-caption flex h-6 max-w-44 items-center rounded-full bg-black/8 text-ui-foreground",
          action ? "pl-0.5" : "px-2.5"
        )}
      >
        {action ? (
          <button
            type="button"
            aria-label={label}
            onClick={action}
            className="h-full truncate rounded-full px-2.5 text-left hover:bg-black/8 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            {label}
          </button>
        ) : (
          <span className="truncate">{label}</span>
        )}
        {canDismiss(state) ? (
          <button
            type="button"
            aria-label="关闭"
            onClick={dismiss}
            className="mr-0.5 grid size-5 shrink-0 place-items-center rounded-full text-ui-muted hover:bg-black/8 hover:text-ui-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function labelFor(state: DesktopUpdateState): string {
  if (state.status === "available") return `新版本 ${state.version}`
  if (state.status === "downloading") return `下载中 ${Math.round(state.percent)}%`
  if (state.status === "downloaded") return "重启安装"
  if (state.status === "error") return "更新失败"
  return ""
}

function actionFor(
  state: DesktopUpdateState,
  download: () => void,
  install: () => void
): (() => void) | undefined {
  if (state.status === "available") return download
  if (state.status === "downloaded") return install
  return undefined
}

function canDismiss(state: DesktopUpdateState): boolean {
  return state.status === "available" || state.status === "error"
}
