import { DesktopShell } from "@renderer/components/desktop/desktop-shell"
import { PetWindow } from "@renderer/components/desktop/pet-window"

function App(): React.JSX.Element {
  const route = window.location.hash.replace(/^#/, "") || "/"

  if (route === "/pet") {
    return <PetWindow />
  }

  return <DesktopShell />
}

export default App
