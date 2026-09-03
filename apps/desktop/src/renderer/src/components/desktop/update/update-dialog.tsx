import { useEffect, useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog"
import type { DesktopUpdateState } from "@shared/update-types"

export function UpdateDialog(): React.JSX.Element | null {
  const [state, setState] = useState<DesktopUpdateState>({ status: "idle" })
  const [dismissed, setDismissed] = useState(false)

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

  useEffect(() => {
    setDismissed(false)
  }, [stateKey(state)])

  const visible = !dismissed && shouldShow(state)
  if (!visible) return null

  return (
    <AlertDialog open={visible} onOpenChange={(open) => !open && setDismissed(true)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{titleFor(state)}</AlertDialogTitle>
          <AlertDialogDescription>{descriptionFor(state)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {state.status === "available" ? (
            <>
              <AlertDialogCancel>稍后</AlertDialogCancel>
              <AlertDialogAction onClick={() => void window.desktop.updates.download()}>
                下载更新
              </AlertDialogAction>
            </>
          ) : null}
          {state.status === "downloaded" ? (
            <>
              <AlertDialogCancel>稍后</AlertDialogCancel>
              <AlertDialogAction onClick={() => void window.desktop.updates.install()}>
                立即重启安装
              </AlertDialogAction>
            </>
          ) : null}
          {state.status === "error" ? <AlertDialogCancel>关闭</AlertDialogCancel> : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function shouldShow(state: DesktopUpdateState): boolean {
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded" ||
    state.status === "error"
  )
}

function stateKey(state: DesktopUpdateState): string {
  if (state.status === "idle" || state.status === "checking") return state.status
  return `${state.status}:${state.version ?? ""}`
}

function titleFor(state: DesktopUpdateState): string {
  if (state.status === "available") return `发现新版本 ${state.version}`
  if (state.status === "downloading") return `正在下载 ${state.version}`
  if (state.status === "downloaded") return `已下载 ${state.version}`
  if (state.status === "error") return "更新失败"
  return "检查更新"
}

function descriptionFor(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return `OpenHarness ${state.version} 已发布。确认后开始下载，下载完成前不会自动安装。`
  }
  if (state.status === "downloading") {
    return `${Math.round(state.percent)}% · ${formatBytes(state.transferred)} / ${formatBytes(state.total)}`
  }
  if (state.status === "downloaded") {
    return `版本 ${state.version} 已下载完成。立即重启即可安装。`
  }
  if (state.status === "error") return state.message
  return "正在检查更新。"
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  return `${(kilobytes / 1024).toFixed(1)} MB`
}
