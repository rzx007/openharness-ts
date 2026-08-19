import { createFileRoute } from "@tanstack/react-router"

import { SettingsLayout } from "@renderer/components/desktop/layout/settings-layout"

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
})
