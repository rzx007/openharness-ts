import React from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../theme/ThemeContext";
import { Logo } from "../components/Logo";

export function Home({ children }: { children: React.ReactNode }): React.ReactNode {
  const { theme } = useTheme();
  const { width } = useTerminalDimensions();

  // Prompt container width: min(80, max(40, floor(width * 0.6)))
  const promptWidth = Math.min(80, Math.max(40, Math.floor(width * 0.6)));

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Top spacer */}
      <box flexGrow={1} />

      {/* Logo centered horizontally */}
      <box flexDirection="row" justifyContent="center">
        <Logo />
      </box>

      {/* 1-line gap */}
      <text>{""}</text>

      {/* Children container centered */}
      <box flexDirection="row" justifyContent="center">
        <box width={promptWidth}>{children}</box>
      </box>

      {/* Hint row: right-aligned, muted with accent keywords */}
      <box flexDirection="row" justifyContent="flex-end">
        <text fg={theme.colors.muted}>
          <span fg={theme.colors.accent}>tab</span>
          <span fg={theme.colors.muted}>{" mode   "}</span>
          <span fg={theme.colors.accent}>ctrl+p</span>
          <span fg={theme.colors.muted}>{" commands"}</span>
        </text>
      </box>

      {/* Bottom spacer */}
      <box flexGrow={1} />
    </box>
  );
}
