import React from "react";
import { useTheme } from "../../theme/ThemeContext";

const MAX_VISIBLE_LINES = 16;

/** 渲染统一 diff：增/删/hunk 头分色，超出可视高度可上下滚动。 */
export function DiffView({ diff }: { diff: string }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const lines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !l.startsWith("\\ No newline"));

  return (
    <scrollbox
      focused
      scrollY
      height={Math.min(lines.length, MAX_VISIBLE_LINES)}
      flexDirection="column"
    >
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return <text key={i} fg={c.muted}>{line}</text>;
        }
        if (line.startsWith("@@")) return <text key={i} fg={c.primary}>{line}</text>;
        if (line.startsWith("+")) return <text key={i} fg={c.success}>{line}</text>;
        if (line.startsWith("-")) return <text key={i} fg={c.error}>{line}</text>;
        return <text key={i} fg={c.muted}>{line}</text>;
      })}
    </scrollbox>
  );
}
