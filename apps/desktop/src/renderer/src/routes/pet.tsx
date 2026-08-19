import { createFileRoute } from "@tanstack/react-router"

import { PetWindow } from "@renderer/components/desktop/pet-page"

export const Route = createFileRoute("/pet")({
  component: PetWindow,
})
