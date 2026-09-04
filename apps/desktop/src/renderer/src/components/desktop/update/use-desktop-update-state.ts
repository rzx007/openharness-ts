import { useCallback, useEffect, useState } from "react"

import type { DesktopUpdateState } from "@shared/update-types"

type DesktopUpdateView = {
  state: DesktopUpdateState
  visible: boolean
  download: () => void
  install: () => void
  dismiss: () => void
}

let dismissedKey: string | null = null

export function useDesktopUpdateState(): DesktopUpdateView {
  const [state, setState] = useState<DesktopUpdateState>({ status: "idle" })
  const [dismissed, setDismissed] = useState(dismissedKey)

  useEffect(() => {
    const updates = window.desktop?.updates
    if (!updates) return
    let cancelled = false
    void updates.getState().then((next) => {
      if (!cancelled) setState(next)
    })
    const unsubscribe = updates.onStateChanged(setState)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const key = stateKey(state)
  const visible = isVisible(state, dismissed)

  const download = useCallback((): void => {
    void window.desktop.updates.download()
  }, [])

  const install = useCallback((): void => {
    void window.desktop.updates.install()
  }, [])

  const dismiss = useCallback((): void => {
    dismissedKey = key
    setDismissed(key)
  }, [key])

  return { state, visible, download, install, dismiss }
}

function isVisible(state: DesktopUpdateState, dismissed: string | null): boolean {
  if (state.status === "downloading" || state.status === "downloaded") return true
  if (state.status !== "available" && state.status !== "error") return false
  return dismissed !== stateKey(state)
}

function stateKey(state: DesktopUpdateState): string {
  if (state.status === "idle" || state.status === "checking") return state.status
  return `${state.status}:${state.version ?? ""}`
}
