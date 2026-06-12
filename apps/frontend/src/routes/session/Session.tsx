import React, { useMemo } from "react";
import { useTheme } from "../../theme/ThemeContext";
import { createSyntaxStyle } from "../../theme/syntax";
import type { TranscriptItem, McpServerSnapshot, SwarmTeammateSnapshot, SwarmNotificationSnapshot } from "../../types";
import { TranscriptPart } from "./parts";
import { Sidebar } from "./Sidebar";

export type SessionProps = {
  items: TranscriptItem[];
  assistantBuffer: string;
  sidebarOpen: boolean;
  status: Record<string, unknown>;
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
};

export function Session({
  items,
  assistantBuffer,
  sidebarOpen,
  status,
  mcpServers,
  todoMarkdown,
  swarmTeammates,
  swarmNotifications,
  version,
}: SessionProps) {
  const { theme } = useTheme();
  const syntax = useMemo(() => createSyntaxStyle(theme), [theme]);

  return (
    <box flexDirection="row" flexGrow={1}>
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
      {sidebarOpen ? (
        <Sidebar
          status={status}
          transcript={items}
          mcpServers={mcpServers}
          todoMarkdown={todoMarkdown}
          swarmTeammates={swarmTeammates}
          swarmNotifications={swarmNotifications}
          version={version}
        />
      ) : null}
    </box>
  );
}
