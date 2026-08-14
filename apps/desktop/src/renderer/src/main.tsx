import "./assets/main.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@renderer/components/theme-provider"
import App from "./App"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="light" storageKey="openharness-desktop-theme">
      <App />
    </ThemeProvider>
  </StrictMode>
)
