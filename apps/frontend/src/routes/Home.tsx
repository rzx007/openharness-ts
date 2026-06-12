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

      {/* Hint row: 对齐输入框右缘（与 opencode 一致），不是屏幕右缘 */}
      <box flexDirection="row" justifyContent="center">
        <box width={promptWidth} flexDirection="row" justifyContent="flex-end">
          <text fg={theme.colors.muted}>
            <span fg={theme.colors.foreground}>tab</span>
            <span fg={theme.colors.muted}>{" mode   "}</span>
            <span fg={theme.colors.foreground}>ctrl+p</span>
            <span fg={theme.colors.muted}>{" commands"}</span>
          </text>
        </box>
      </box>

      {/* Bottom spacer */}
      <box flexGrow={1} />
    </box>
  );
}
