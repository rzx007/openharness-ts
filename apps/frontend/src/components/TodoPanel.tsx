import React from "react";
import { useTheme } from "../theme/ThemeContext";

export type TodoItem = {
  text: string;
  checked: boolean;
};

export function parseTodoItems(markdown: string): TodoItem[] {
  const lines = markdown.split("\n");
  const items: TodoItem[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)/);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      items.push({ checked: m[1].toLowerCase() === "x", text: m[2].trim() });
    }
  }
  return items;
}

export type TodoPanelProps = {
  markdown: string;
};

export function TodoPanel({ markdown }: TodoPanelProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const items = parseTodoItems(markdown);
  if (items.length === 0) return null;

  const done = items.filter((i) => i.checked).length;
  const total = items.length;
  const allDone = done === total;

  if (allDone) {
    return (
      <text fg={c.success}>{"▣ ✓ all done"}</text>
    );
  }

  const firstPending = items.find((i) => !i.checked);
  const pendingText = firstPending ? firstPending.text.slice(0, 50) : "";

  return (
    <text fg={c.muted}>
      {`▣ ${done}/${total} `}
      {pendingText}
    </text>
  );
}
