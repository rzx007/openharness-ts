import "./assets/main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppearanceProvider } from "@renderer/components/appearance/appearance-provider"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppearanceProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </AppearanceProvider>
  </StrictMode>
)
