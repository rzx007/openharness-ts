import React from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";

const MAX_VISIBLE_LINES = 18;

export function DialogText({ title, content }: { title: string; content: string }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const lines = content.replace(/\n$/, "").split("\n");

  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={c.accent}>{title}</text>
      <scrollbox
        focused
        scrollY
        height={Math.min(Math.max(lines.length, 1), MAX_VISIBLE_LINES)}
        flexDirection="column"
      >
        {lines.map((line, index) => (
          <text key={index} fg={c.foreground} wrapMode="word">
            {line.length > 0 ? line : " "}
          </text>
        ))}
      </scrollbox>
      <text fg={c.muted}>esc close</text>
    </box>
  );
}
