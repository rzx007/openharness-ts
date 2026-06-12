import type React from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useBackendSession } from "./hooks/useBackendSession";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import type { FrontendConfig } from "./types";

export function App({ config }: { config: FrontendConfig }): React.ReactNode {
  const initialTheme = String(config.theme ?? "default");
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <AppInner config={config} />
    </ThemeProvider>
  );
}

function AppInner({ config }: { config: FrontendConfig }): React.ReactNode {
  const { theme } = useTheme();
  const renderer = useRenderer();
  const session = useBackendSession(config, (code) => {
    process.exit(code ?? 0);
  });

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      session.sendRequest({ type: "shutdown" });
      renderer.destroy();
      process.exit(0);
    }
  });

  if (!session.ready) {
    return <text fg={theme.colors.warning}>Connecting to backend...</text>;
  }

  return (
    <box flexDirection="column">
      <text>ready · transcript: {session.transcript.length} items</text>
    </box>
  );
}
