import "./assets/main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@renderer/components/theme-provider"
import { TooltipProvider } from "@renderer/components/ui/tooltip"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light" storageKey="openharness-desktop-theme">
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
