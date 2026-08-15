import { ChevronRight, Code2 } from "lucide-react"
import type * as React from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { OpenerIcon } from "@renderer/components/desktop/open-with/opener-icon"
import {
  launchWorkspaceOpener,
  useWorkspaceOpeners,
} from "@renderer/components/desktop/open-with/use-workspace-openers"

export function OpenWithSubmenu({
  path,
  rootPath,
  onPicked,
  onError,
}: {
  path: string
  rootPath?: string
  onPicked?: () => void
  onError?: (error: unknown) => void
}): React.JSX.Element {
  const { openers, ready } = useWorkspaceOpeners()
  const itemRef = useRef<HTMLDivElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const clearCloseTimer = (): void => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const closeSoon = (): void => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120)
  }

  const placeSubmenu = (): void => {
    const trigger = itemRef.current
    const submenu = submenuRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const width = submenu?.offsetWidth || 224
    const height = submenu?.offsetHeight || 168
    const openRight = rect.right + width + margin <= window.innerWidth
    const left = openRight ? rect.right - 2 : Math.max(margin, rect.left - width + 2)
    const top = Math.min(
      Math.max(margin, rect.top),
      Math.max(margin, window.innerHeight - height - margin)
    )
    setPosition({ top, left })
  }

  const openSubmenu = (): void => {
    clearCloseTimer()
    placeSubmenu()
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    placeSubmenu()
    const handleReposition = (): void => placeSubmenu()
    window.addEventListener("resize", handleReposition)
    window.addEventListener("scroll", handleReposition, true)
    return () => {
      window.removeEventListener("resize", handleReposition)
      window.removeEventListener("scroll", handleReposition, true)
    }
  }, [open, openers.length, ready])

  useEffect(() => () => clearCloseTimer(), [])

  const pickOpener = (openerId: string): void => {
    void launchWorkspaceOpener({ openerId, path, rootPath }).catch((error) => {
      onError?.(error)
    })
    onPicked?.()
  }

  return (
    <div
      ref={itemRef}
      onMouseEnter={openSubmenu}
      onMouseLeave={closeSoon}
      onFocus={openSubmenu}
      onBlur={closeSoon}
    >
      <button
        type="button"
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0"
      >
        <Code2 className="text-ui-muted" strokeWidth={1.8} />
        <span className="min-w-0 flex-1">打开方式</span>
        <ChevronRight className="text-ui-muted" strokeWidth={1.8} />
      </button>
      {open &&
        createPortal(
          <div
            ref={submenuRef}
            role="menu"
            data-file-tree-context-menu-root="true"
            style={{ top: position.top, left: position.left }}
            onMouseEnter={openSubmenu}
            onMouseLeave={closeSoon}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            className="fixed z-80 w-56 rounded-xl border border-border/55 bg-popover p-1.5 text-[13px] text-popover-foreground shadow-xl shadow-black/12 dark:border-white/8 dark:shadow-black/40"
          >
            {!ready ? (
              <p className="px-2.5 py-2 text-[12px] text-ui-muted">正在查找打开方式…</p>
            ) : openers.length === 0 ? (
              <p className="px-2.5 py-2 text-[12px] text-ui-muted">未找到可用的打开方式</p>
            ) : (
              openers.map((opener) => (
                <button
                  key={opener.id}
                  type="button"
                  role="menuitem"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    pickOpener(opener.id)
                  }}
                  className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <OpenerIcon opener={opener} />
                  <span className="min-w-0 flex-1 truncate">{opener.label}</span>
                </button>
              ))
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
