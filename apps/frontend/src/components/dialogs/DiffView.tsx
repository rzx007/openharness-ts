import React from "react";
import { useTheme } from "../../theme/ThemeContext";

const MAX_DIFF_LINES = 40;

/** 渲染统一 diff：增/删/hunk 头分色，超出 MAX_DIFF_LINES 截断并提示剩余行数。 */
export function DiffView({ diff }: { diff: string }) {
  const { theme } = useTheme();
  const c = theme.colors;
  const allLines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !l.startsWith("\\ No newline"));
  const lines = allLines.slice(0, MAX_DIFF_LINES);
  const truncated = allLines.length - lines.length;

  return (
    <box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return <text key={i} fg={c.muted}>{line}</text>;
        }
        if (line.startsWith("@@")) return <text key={i} fg={c.primary}>{line}</text>;
        if (line.startsWith("+")) return <text key={i} fg={c.success}>{line}</text>;
        if (line.startsWith("-")) return <text key={i} fg={c.error}>{line}</text>;
        return <text key={i} fg={c.muted}>{line}</text>;
      })}
      {truncated > 0 && (
        <text fg={c.muted}>{`  … ${truncated} more line(s)`}</text>
      )}
    </box>
  );
}
