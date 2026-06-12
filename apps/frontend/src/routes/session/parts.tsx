import React from "react";
import { TextAttributes } from "@opentui/core";
import type { SyntaxStyle } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import type { TranscriptItem } from "../../types";
import { ToolDiff } from "../../components/messages/ToolDiff";

/**
 * Pick the first "summary" value from a tool_input record.
 * Priority: command > file_path > path > pattern > url; then first key.
 * Result is truncated to `maxLen` chars.
 */
function summarizeToolInput(
  toolInput: Record<string, unknown> | undefined,
  maxLen = 60,
): string {
  if (!toolInput) return "";
  const priority = ["command", "file_path", "path", "pattern", "url"];
  for (const key of priority) {
    const val = toolInput[key];
    if (val !== undefined && val !== null && typeof val === "string") {
      return val.slice(0, maxLen);
    }
  }
  // Fallback: first string-valued key
  for (const [, val] of Object.entries(toolInput)) {
    if (typeof val === "string") {
      return val.slice(0, maxLen);
    }
  }
  return "";
}

export function TranscriptPart({
  item,
  syntax,
}: {
  item: TranscriptItem;
  syntax: SyntaxStyle;
}) {
  const { theme } = useTheme();
  const c = theme.colors;
  const icons = theme.icons;

  switch (item.role) {
    case "user":
      return (
        <text fg={c.accent}>{icons.user + item.text}</text>
      );

    case "assistant":
      return <markdown content={item.text} syntaxStyle={syntax} />;

    case "tool": {
      const toolName = item.tool_name ?? "tool";

      const isEditTool = toolName === "Edit" || toolName === "str_replace_editor";
      const isWriteTool = toolName === "Write" || toolName === "create_file";

      if (isEditTool && item.tool_input?.old_string !== undefined && item.tool_input?.new_string !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const oldText = String(item.tool_input.old_string);
        const newText = String(item.tool_input.new_string);
        const addedLines = newText.split("\n").length - oldText.split("\n").length;
        const sign = addedLines >= 0 ? `+${addedLines}` : `${addedLines}`;
        return (
          <box flexDirection="column">
            <text fg={c.muted}>
              <span fg={c.muted}>{icons.tool}</span>
              <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
              <span fg={addedLines >= 0 ? c.success : c.error}>{" " + sign}</span>
            </text>
            <ToolDiff filePath={filePath} oldText={oldText} newText={newText} syntaxStyle={syntax} />
          </box>
        );
      }

      if (isWriteTool && item.tool_input?.content !== undefined) {
        const filePath = String(item.tool_input.path ?? item.tool_input.file_path ?? "file");
        const content = String(item.tool_input.content);
        return (
          <box flexDirection="column">
            <text fg={c.muted}>
              <span fg={c.muted}>{icons.tool}</span>
              <span fg={c.foreground} attributes={TextAttributes.BOLD}>{filePath}</span>
              <span fg={c.success}>{` +${content.split("\n").length}`}</span>
            </text>
            <ToolDiff filePath={filePath} oldText="" newText={content} syntaxStyle={syntax} />
          </box>
        );
      }

      const summary = summarizeToolInput(item.tool_input);
      return (
        <text fg={c.muted}>
          <span fg={c.muted}>{icons.tool}</span>
          <span fg={c.muted} attributes={TextAttributes.BOLD}>
            {toolName}
          </span>
          {summary ? <span fg={c.muted}>{" " + summary}</span> : null}
        </text>
      );
    }

    case "tool_result": {
      if (item.is_error) {
        return (
          <text fg={c.error} wrapMode="word">
            {"└ "}
            {item.text}
          </text>
        );
      }
      const firstLine = item.text.split("\n")[0] ?? "";
      return (
        <text fg={c.muted}>
          {"└ "}
          {firstLine.slice(0, 80)}
        </text>
      );
    }

    case "system":
    case "log":
      return <text fg={c.muted}>{item.text}</text>;

    default:
      return <text>{item.text}</text>;
  }
}
