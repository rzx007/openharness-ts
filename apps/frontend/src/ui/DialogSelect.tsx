import React, { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";
import { fuzzyFilter } from "./fuzzy";

export type DialogSelectItem = {
  value: string;
  label: string;
  description?: string;
  hint?: string;
  active?: boolean;
};

const MAX_VISIBLE = 10;

export function DialogSelect(props: {
  title: string;
  items: DialogSelectItem[];
  onSelect: (value: string) => void;
  searchable?: boolean;
  initialIndex?: number;
}): React.ReactNode {
  const { title, items, onSelect, searchable = true, initialIndex = 0 } = props;
  const { theme } = useTheme();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const mountedRef = useRef(false);

  const filtered = searchable
    ? fuzzyFilter(items, query, (i) => i.label)
    : items;

  // Reset selection when query changes（跳过挂载帧，保住 initialIndex）
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setSelectedIndex(0);
  }, [query]);

  // Compute visible window: ensure selectedIndex is visible
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE / 2),
      filtered.length - MAX_VISIBLE,
    ),
  );
  const visibleItems = filtered.slice(windowStart, windowStart + MAX_VISIBLE);

  useKeyboard((key) => {
    if (filtered.length === 0) return;

    if (key.name === "up") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.name === "down") {
      setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
      return;
    }
    if (key.name === "return") {
      const item = filtered[selectedIndex];
      if (item) onSelect(item.value);
      return;
    }

    // Digit shortcuts 1-9 only when not searchable
    if (!searchable) {
      const digit = key.name ? parseInt(key.name, 10) : NaN;
      if (!isNaN(digit) && digit >= 1 && digit <= 9) {
        const targetIndex = digit - 1;
        const item = filtered[targetIndex];
        if (item) onSelect(item.value);
      }
    }
  });

  return (
    <box flexDirection="column">
      {/* Title row */}
      <text attributes={TextAttributes.BOLD} fg={theme.colors.accent}>
        {title}
      </text>

      {/* Search input */}
      {searchable && (
        <input
          focused
          placeholder="Search..."
          onInput={(value: string) => setQuery(value)}
        />
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <text fg={theme.colors.muted}>no matches</text>
      ) : (
        visibleItems.map((item, visibleIdx) => {
          const absoluteIdx = windowStart + visibleIdx;
          const isSelected = absoluteIdx === selectedIndex;
          const prefix = item.active ? "✓ " : "  ";

          return (
            <box
              key={item.value}
              flexDirection="row"
              backgroundColor={
                isSelected ? theme.colors.accent : undefined
              }
            >
              <text
                fg={isSelected ? theme.colors.background : theme.colors.foreground}
              >
                {prefix}
                {item.label}
              </text>
              {item.description != null && (
                <text fg={theme.colors.muted}>
                  {" "}
                  {item.description}
                </text>
              )}
              {item.hint != null && (
                <text fg={theme.colors.muted}> {item.hint}</text>
              )}
            </box>
          );
        })
      )}
    </box>
  );
}
