import { createRootRoute, Outlet } from "@tanstack/react-router"

import { Spinner } from "@renderer/components/ui/spinner"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"
import { selectDaemonStatus } from "@renderer/stores/desktop-session/selectors"

export const Route = createRootRoute({
  component: Outlet,
  pendingComponent: DesktopRoutePending,
})

function DesktopRoutePending(): React.JSX.Element {
  const daemonStatus = useDesktopSessionStore(selectDaemonStatus)

  return (
    <div className="flex h-screen min-w-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-100 flex-col items-center gap-3 text-center" aria-live="polite">
        <Spinner className="size-5 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">正在启动 Desktop</p>
          <p className="mt-1 text-xs text-muted-foreground">{daemonStatus.message}</p>
        </div>
        {daemonStatus.detail ? (
          <p className="max-w-full truncate text-[11px] text-muted-foreground/80">
            {daemonStatus.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}
