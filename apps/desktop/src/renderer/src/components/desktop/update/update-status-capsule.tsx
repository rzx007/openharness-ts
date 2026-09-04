import { ArrowUp, CircleCheck, LoaderCircle, X } from "lucide-react"

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
        data-update-capsule
        className={cn(
          "text-ui-caption flex h-6 max-w-44 items-center rounded-full font-medium",
          toneFor(state),
          action ? "pl-0.5" : "px-2.5"
        )}
      >
        {action ? (
          <button
            type="button"
            aria-label={label}
            onClick={action}
            className="flex h-full items-center gap-1 truncate rounded-full px-2.5 text-left hover:bg-black/8 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            {iconFor(state)}
            {label}
          </button>
        ) : (
          <span className="flex items-center gap-1 truncate">
            {iconFor(state)}
            {label}
          </span>
        )}
        {canDismiss(state) ? (
          <button
            type="button"
            aria-label="关闭"
            onClick={dismiss}
            className="mr-0.5 grid size-5 shrink-0 place-items-center rounded-full opacity-80 hover:bg-black/8 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
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

function iconFor(state: DesktopUpdateState): React.JSX.Element | null {
  if (state.status === "available") return <ArrowUp className="size-3 shrink-0" />
  if (state.status === "downloading") {
    return <LoaderCircle data-update-capsule-spinner className="size-3 shrink-0 animate-spin" />
  }
  if (state.status === "downloaded") return <CircleCheck className="size-3 shrink-0" />
  return null
}

function toneFor(state: DesktopUpdateState): string {
  if (state.status === "available") return "bg-primary/15 text-primary"
  if (state.status === "downloading" || state.status === "downloaded") {
    return "bg-primary text-primary-foreground"
  }
  if (state.status === "error") return "bg-destructive/15 text-destructive"
  return "bg-black/8 text-ui-foreground"
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
