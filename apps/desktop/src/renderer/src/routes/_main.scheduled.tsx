import { createFileRoute } from "@tanstack/react-router"

import { useMainLayout } from "@renderer/components/desktop/layout/main-layout-context"
import { ScheduledPage } from "@renderer/components/desktop/scheduled-page"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session-store"

export const Route = createFileRoute("/_main/scheduled")({
  beforeLoad: () => useDesktopSessionStore.getState().initialize(),
  component: ScheduledRoute,
})

function ScheduledRoute(): React.JSX.Element {
  const { startNewConversation } = useMainLayout()
  return <ScheduledPage onStartConversation={startNewConversation} />
}
