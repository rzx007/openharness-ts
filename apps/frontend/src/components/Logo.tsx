import React from "react";
import { useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";

// "slick" font: each char is approximately 6 columns wide + 1 space
// "openharness" = 11 chars × ~7 cols ≈ 77 cols — use as threshold
const LOGO_MIN_WIDTH = 78;

export function Logo(): React.ReactNode {
  const { theme } = useTheme();
  const { width } = useTerminalDimensions();

  if (width < LOGO_MIN_WIDTH) {
    // Narrow fallback: single-line bold text with span dual-color
    return (
      <text attributes={TextAttributes.BOLD}>
        <span fg={theme.colors.muted}>open</span>
        <span fg={theme.colors.foreground}>harness</span>
      </text>
    );
  }

  // Wide: two side-by-side ascii-font elements for dual-color effect
  return (
    <box flexDirection="row">
      <ascii-font text="open" font="slick" color={theme.colors.muted} />
      <ascii-font text="harness" font="slick" color={theme.colors.foreground} />
    </box>
  );
}
