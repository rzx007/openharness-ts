import React from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { fuzzyFilter } from "../../ui/fuzzy";
import type { Command } from "../../keymap/commands";

const MAX_SUGGESTIONS = 8;

export type AutocompleteProps = {
  query: string;
  commands: Command[];
  selectedIndex: number;
};

export function Autocomplete({
  query,
  commands,
  selectedIndex,
}: AutocompleteProps): React.ReactNode {
  const { theme } = useTheme();

  const filtered = fuzzyFilter(commands, query, (c) => c.id).slice(
    0,
    MAX_SUGGESTIONS,
  );

  if (filtered.length === 0) return null;

  return (
    <box
      flexDirection="column"
      backgroundColor={theme.colors.backgroundPanel}
      borderStyle="single"
      borderColor={theme.colors.muted}
    >
      {filtered.map((cmd, idx) => {
        const isSelected = idx === selectedIndex;
        return (
          <box
            key={cmd.id}
            flexDirection="row"
            backgroundColor={isSelected ? theme.colors.accent : undefined}
          >
            <text
              fg={
                isSelected
                  ? theme.colors.background
                  : theme.colors.foreground
              }
              attributes={isSelected ? TextAttributes.BOLD : TextAttributes.NONE}
            >
              {`  ${cmd.id}`}
            </text>
            {cmd.title !== cmd.id && (
              <text
                fg={isSelected ? theme.colors.background : theme.colors.muted}
              >
                {`  ${cmd.title}`}
              </text>
            )}
          </box>
        );
      })}
    </box>
  );
}

/**
 * Given a query and command list, return the filtered suggestions (max 8).
 */
export function getAutocompleteSuggestions(
  query: string,
  commands: Command[],
): Command[] {
  return fuzzyFilter(commands, query, (c) => c.id).slice(0, MAX_SUGGESTIONS);
}
