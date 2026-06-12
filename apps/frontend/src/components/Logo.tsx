import React from "react";
import { useTerminalDimensions } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";

// 实测（bun probe）："openharness" block 字体共 102 列 ×6 行；slick 约 77 列。
// 对齐 opencode 的实心 block 观感，宽度不足时逐级降级。
const BLOCK_MIN_WIDTH = 104;
const SLICK_MIN_WIDTH = 78;

export function Logo(): React.ReactNode {
  const { theme } = useTheme();
  const { width } = useTerminalDimensions();

  if (width < SLICK_MIN_WIDTH) {
    // Narrow fallback: single-line bold text with span dual-color
    return (
      <text attributes={TextAttributes.BOLD}>
        <span fg={theme.colors.muted}>open</span>
        <span fg={theme.colors.foreground}>harness</span>
      </text>
    );
  }

  const font = width >= BLOCK_MIN_WIDTH ? "block" : "slick";
  // Two side-by-side ascii-font elements for dual-color effect
  return (
    <box flexDirection="row">
      <ascii-font text="open" font={font} color={theme.colors.muted} />
      <ascii-font text="harness" font={font} color={theme.colors.foreground} />
    </box>
  );
}
