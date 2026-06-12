import React, { useMemo } from "react";
import { useTheme } from "../../theme/ThemeContext";
import { createSyntaxStyle } from "../../theme/syntax";
import type { TranscriptItem } from "../../types";
import { TranscriptPart } from "./parts";

export type SessionProps = {
  items: TranscriptItem[];
  assistantBuffer: string;
};

export function Session({ items, assistantBuffer }: SessionProps) {
  const { theme } = useTheme();
  const syntax = useMemo(() => createSyntaxStyle(theme), [theme]);

  return (
    <scrollbox
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      verticalScrollbarOptions={{
        trackOptions: {
          foregroundColor: theme.colors.muted,
          backgroundColor: theme.colors.backgroundPanel,
        },
      }}
    >
      {items.map((item, i) => (
        <TranscriptPart key={i} item={item} syntax={syntax} />
      ))}
      {assistantBuffer ? (
        <markdown content={assistantBuffer} syntaxStyle={syntax} streaming />
      ) : null}
    </scrollbox>
  );
}
