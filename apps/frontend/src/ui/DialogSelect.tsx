import { useState, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTheme } from "../theme/ThemeContext";
import { fuzzyFilter } from "./fuzzy";
import { useListNavigation } from "../hooks/useListNavigation";
import { AC_VISIBLE_ITEMS } from "./constants";

const SCROLLBOX_CHROME_ROWS = 3;

export type DialogSelectItem = {
  value: string;
  label: string;
  description?: string;
  hint?: string;
  active?: boolean;
};

export function DialogSelect(props: {
  title: string;
  items: DialogSelectItem[];
  onSelect: (value: string) => void;
  onDelete?: (value: string) => void;
  searchable?: boolean;
  initialIndex?: number;
}) {
  const { title, items, onSelect, onDelete, searchable = true, initialIndex = 0 } = props;
  const { theme } = useTheme();

  const [query, setQuery] = useState("");
  const mountedRef = useRef(false);
  const listRef = useRef<ScrollBoxRenderable | null>(null);

  const filtered = searchable
    ? fuzzyFilter(items, query, (i) => i.label)
    : items;

  const { index: selectedIndex, setIndex: setSelectedIndex, moveUp, moveDown } =
    useListNavigation(filtered.length);

  // Keep the caller's initial preselection on mount, then reset filtered lists to the top.
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      setSelectedIndex(initialIndex);
      return;
    }
    setSelectedIndex(0);
    listRef.current?.scrollTo(0);
  }, [query, initialIndex, setSelectedIndex]);

  // After deleting/filtering items, keep the highlighted row inside the list.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (selectedIndex >= filtered.length) setSelectedIndex(filtered.length - 1);
  }, [filtered.length, selectedIndex, setSelectedIndex]);

  useEffect(() => {
    if (filtered.length === 0) return;
    listRef.current?.scrollChildIntoView(`dialog-select-row-${selectedIndex}`);
  }, [filtered.length, selectedIndex]);

  const listHeight = Math.min(filtered.length, AC_VISIBLE_ITEMS) + SCROLLBOX_CHROME_ROWS;

  useKeyboard((key) => {
    if (filtered.length === 0) return;

    if (key.name === "up") { moveUp(); return; }
    if (key.name === "down") { moveDown(); return; }
    if (key.name === "return") {
      const item = filtered[selectedIndex];
      if (item) onSelect(item.value);
      return;
    }
    if (key.ctrl && key.name === "d" && onDelete) {
      const item = filtered[selectedIndex];
      if (item) onDelete(item.value);
      return;
    }
    if (key.name === "pageup") {
      listRef.current?.scrollBy(-1, "viewport");
      return;
    }
    if (key.name === "pagedown") {
      listRef.current?.scrollBy(1, "viewport");
      return;
    }

    // Digit shortcuts 1-9 only when not searchable.
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
      <text attributes={TextAttributes.BOLD} fg={theme.colors.accent}>
        {title}
      </text>

      {searchable && (
        <input
          focused
          placeholder="Search..."
          onInput={(value: string) => setQuery(value)}
        />
      )}

      {filtered.length === 0 ? (
        <text fg={theme.colors.muted}>no matches</text>
      ) : (
        <>
          <scrollbox
            ref={listRef}
            scrollY
            width="100%"
            height={listHeight}
            flexDirection="column"
            viewportCulling={false}
            horizontalScrollbarOptions={{ visible: false }}
          >
            {filtered.map((item, index) => {
              const isSelected = index === selectedIndex;
              const prefix = item.active ? "✓ " : "  ";

              return (
                <box
                  key={item.value}
                  id={`dialog-select-row-${index}`}
                  flexDirection="row"
                  width="100%"
                  height={1}
                  flexShrink={0}
                  backgroundColor={isSelected ? theme.colors.accent : undefined}
                  onMouseUp={() => {
                    setSelectedIndex(index);
                    onSelect(item.value);
                  }}
                >
                  <text fg={isSelected ? theme.colors.background : theme.colors.foreground}>
                    {prefix}
                    {item.label}
                  </text>
                  {item.description != null && (
                    <text fg={theme.colors.muted}> {item.description}</text>
                  )}
                  {item.hint != null && (
                    <text fg={theme.colors.muted}> {item.hint}</text>
                  )}
                </box>
              );
            })}
          </scrollbox>
          {onDelete && (
            <text fg={theme.colors.muted}>  ctrl+d delete</text>
          )}
        </>
      )}
    </box>
  );
}
