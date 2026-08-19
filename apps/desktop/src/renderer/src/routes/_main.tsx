import { createFileRoute } from "@tanstack/react-router"

import { MainLayout } from "@renderer/components/desktop/layout/main-layout"

export const Route = createFileRoute("/_main")({
  component: MainLayout,
})
