import React from "react";
import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { parseTodoItems } from "../../components/TodoPanel";
import type { TranscriptItem, McpServerSnapshot, SwarmTeammateSnapshot, SwarmNotificationSnapshot } from "../../types";

export type ModifiedFile = {
  path: string;
  added: number;
  removed: number;
};

export function computeModifiedFiles(transcript: TranscriptItem[]): ModifiedFile[] {
  const map = new Map<string, ModifiedFile>();
  for (const item of transcript) {
    if (item.role !== "tool") continue;
    const name = item.tool_name ?? "";
    const isEdit = name === "Edit" || name === "str_replace_editor";
    const isWrite = name === "Write" || name === "create_file";
    if (!isEdit && !isWrite) continue;

    const path = String(item.tool_input?.path ?? item.tool_input?.file_path ?? "");
    if (!path) continue;

    if (isEdit) {
      const old = String(item.tool_input?.old_string ?? "");
      const next = String(item.tool_input?.new_string ?? "");
      map.set(path, { path, added: next.split("\n").length, removed: old.split("\n").length });
    } else {
      const content = String(item.tool_input?.content ?? "");
      map.set(path, { path, added: content.split("\n").length, removed: 0 });
    }
  }
  return Array.from(map.values());
}

function SectionHeader({ title, muted }: { title: string; muted: string }) {
  return (
    <text fg={muted} attributes={TextAttributes.BOLD}>
      {" " + title.toUpperCase()}
    </text>
  );
}

export type SidebarProps = {
  status: Record<string, unknown>;
  transcript: TranscriptItem[];
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
};

export function Sidebar({
  status,
  transcript,
  mcpServers,
  todoMarkdown,
  swarmTeammates,
}: SidebarProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const mode = String(status.permission_mode ?? "");
  const model = String(status.model ?? "");
  const effort = String(status.effort ?? "");
  const inputTokens = Number(status.input_tokens ?? 0);
  const outputTokens = Number(status.output_tokens ?? 0);

  const modifiedFiles = computeModifiedFiles(transcript);
  const todoItems = parseTodoItems(todoMarkdown);
  const shownFiles = modifiedFiles.slice(0, 15);
  const extraFiles = modifiedFiles.length - shownFiles.length;

  return (
    <box
      flexDirection="column"
      width={40}
      flexShrink={0}
      borderColor={c.muted}
      border={["left"]}
      customBorderChars={{
        topLeft: "", bottomLeft: "", vertical: "│",
        topRight: "", bottomRight: "", horizontal: " ",
        bottomT: "", topT: "", cross: "", leftT: "", rightT: "",
      }}
    >
      <SectionHeader title="Session" muted={c.muted} />
      {model ? <text fg={c.foreground}>{" " + model}</text> : null}
      {mode ? <text fg={c.muted}>{" mode: " + mode}</text> : null}
      {effort ? <text fg={c.warning}>{" effort: " + effort}</text> : null}
      {(inputTokens > 0 || outputTokens > 0) ? (
        <text fg={c.muted}>{` ${inputTokens}↓ ${outputTokens}↑`}</text>
      ) : null}

      {shownFiles.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Modified" muted={c.muted} />
          {shownFiles.map((f) => (
            <text key={f.path} fg={c.muted}>
              <span fg={c.success}>{`+${f.added}`}</span>
              <span fg={c.error}>{`-${f.removed}`}</span>
              {" " + f.path.split("/").pop()}
            </text>
          ))}
          {extraFiles > 0 ? <text fg={c.muted}>{`  +${extraFiles} more`}</text> : null}
        </box>
      ) : null}

      {todoItems.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Tasks" muted={c.muted} />
          {todoItems.slice(0, 8).map((item, i) => (
            <text key={i} fg={item.checked ? c.muted : c.foreground}>
              {(item.checked ? " ✓ " : " ○ ") + item.text.slice(0, 34)}
            </text>
          ))}
        </box>
      ) : null}

      {swarmTeammates.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="Swarm" muted={c.muted} />
          {swarmTeammates.map((t) => (
            <text key={t.name} fg={c.muted}>{" " + t.name.slice(0, 34)}</text>
          ))}
        </box>
      ) : null}

      {mcpServers.length > 0 ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <SectionHeader title="MCP" muted={c.muted} />
          {mcpServers.map((s) => {
            const dot = s.state === "connected" || s.state === "ok" ? "●" : "○";
            const dotColor = s.state === "error" ? c.error
              : (s.state === "connected" || s.state === "ok") ? c.success
              : c.muted;
            const tools = s.tool_count ? ` (${s.tool_count})` : "";
            return (
              <text key={s.name} fg={c.muted}>
                <span fg={dotColor}>{dot}</span>
                {" " + s.name.slice(0, 32) + tools}
              </text>
            );
          })}
        </box>
      ) : null}
    </box>
  );
}
