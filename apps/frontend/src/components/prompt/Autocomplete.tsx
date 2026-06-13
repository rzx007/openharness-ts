import React from "react";
import { useTheme } from "../../theme/ThemeContext";
import { AC_VISIBLE_ITEMS } from "../../ui/constants";

export type AutocompleteItem = {
  id: string;
  label: string;
  detail?: string;
};

export type AutocompleteProps = {
  items: AutocompleteItem[];
  selectedIndex: number;
};

export function Autocomplete({ items, selectedIndex }: AutocompleteProps) {
  const { theme } = useTheme();
  const total = items.length;
  if (total === 0) return null;

  // 滑动视口：始终让选中项保持可见（居中优先）
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(AC_VISIBLE_ITEMS / 2),
      total - AC_VISIBLE_ITEMS,
    ),
  );
  const visible = items.slice(windowStart, windowStart + AC_VISIBLE_ITEMS);

  const nameColWidth = Math.max(...visible.map((c) => c.label.length)) + 4;

  return (
    <box flexDirection="column" backgroundColor={theme.colors.backgroundPanel}>
      {visible.map((item, localIdx) => {
        const isSelected = windowStart + localIdx === selectedIndex;
        return (
          <box
            key={item.id}
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
              {item.label.padEnd(nameColWidth)}
            </text>
            {item.detail ? (
              <text fg={isSelected ? theme.colors.background : theme.colors.muted}>
                {item.detail}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
