import React from "react";
import { useTheme } from "../../theme/ThemeContext";
import { fuzzyFilter } from "../../ui/fuzzy";
import type { Command } from "../../keymap/commands";

// 对齐 opencode：补全面板最多 10 行，贴输入框上方全宽展开
const MAX_SUGGESTIONS = 10;

export type AutocompleteProps = {
  query: string;
  commands: Command[];
  selectedIndex: number;
};

export function Autocomplete({
  query,
  commands,
  selectedIndex,
}: AutocompleteProps) {
  const { theme } = useTheme();

  const filtered = getAutocompleteSuggestions(query, commands);
  if (filtered.length === 0) return null;

  // 命令名列定宽：描述竖向对齐（opencode 同款两列布局）
  const nameColWidth = Math.max(...filtered.map((c) => c.id.length)) + 4;

  return (
    <box flexDirection="column" backgroundColor={theme.colors.backgroundPanel}>
      {filtered.map((cmd, idx) => {
        const isSelected = idx === selectedIndex;
        const hasDesc = cmd.title !== cmd.id;
        return (
          <box
            key={cmd.id}
            flexDirection="row"
            width="100%"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isSelected ? theme.colors.accent : undefined}
          >
            <text
              fg={isSelected ? theme.colors.background : theme.colors.foreground}
              flexShrink={0}
            >
              {cmd.id.padEnd(nameColWidth)}
            </text>
            {hasDesc && (
              <text fg={isSelected ? theme.colors.background : theme.colors.muted}>
                {cmd.title}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

/**
 * Given a query and command list, return the filtered suggestions (max 10).
 */
export function getAutocompleteSuggestions(
  query: string,
  commands: Command[],
): Command[] {
  return fuzzyFilter(commands, query, (c) => c.id).slice(0, MAX_SUGGESTIONS);
}
