import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeContext";
import type { TranscriptItem } from "../types";
import { Markdown } from "./Markdown";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { WelcomeBanner } from "./WelcomeBanner";

/** 折叠摘要或原始项（E.3 tool 行分组折叠）。 */
type TranscriptCell =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "folded"; count: number; names: string[] };

/**
 * 把连续的 tool/tool_result 段分组：最新一组保持展开（可能仍在进行中），
 * 更早的组折叠成一行摘要。纯函数便于单测。
 */
export function foldTranscript(items: TranscriptItem[]): TranscriptCell[] {
  // 先扫出所有 tool 连续段
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= items.length; i++) {
    const isTool = i < items.length && (items[i]!.role === "tool" || items[i]!.role === "tool_result");
    if (isTool && runStart === -1) runStart = i;
    if (!isTool && runStart !== -1) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }

  const lastRunStart = runs.length > 0 ? runs[runs.length - 1]!.start : -1;
  const cells: TranscriptCell[] = [];
  let i = 0;
  while (i < items.length) {
    const run = runs.find((r) => r.start === i);
    if (run && run.start !== lastRunStart) {
      const slice = items.slice(run.start, run.end);
      const names = [...new Set(slice.filter((x) => x.role === "tool").map((x) => x.tool_name ?? "tool"))];
      cells.push({ kind: "folded", count: slice.filter((x) => x.role === "tool").length, names });
      i = run.end;
      continue;
    }
    cells.push({ kind: "item", item: items[i]! });
    i += 1;
  }
  return cells;
}

export function ConversationView({
  items,
  assistantBuffer,
  showWelcome,
  outputStyle = "default",
}: {
  items: TranscriptItem[];
  assistantBuffer: string;
  showWelcome: boolean;
  /** E.3：输出样式名（state.output_style），minimal 走极简工具行。 */
  outputStyle?: string;
}): React.JSX.Element {
  const { theme } = useTheme();
  const cells = foldTranscript(items.slice(-40));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {showWelcome && items.length === 0 ? <WelcomeBanner /> : null}

      {cells.map((cell, index) =>
        cell.kind === "folded" ? (
          <Box key={index} marginLeft={2}>
            <Text dimColor>
              {`▸ ${cell.count} 个工具调用（${cell.names.slice(0, 5).join(", ")}${cell.names.length > 5 ? "…" : ""}）`}
            </Text>
          </Box>
        ) : (
          <MessageRow key={index} item={cell.item} theme={theme} outputStyle={outputStyle} />
        ),
      )}

      {assistantBuffer ? (
        // 流式增量阶段用纯文本渲染，避免每个 token 触发 markdown 重排导致闪烁；
        // 消息完成后会进入 items，由下方 MessageRow 以 Markdown 渲染。
        <Box flexDirection="row" marginTop={0}>
          <Text color={theme.colors.success} bold>{theme.icons.assistant}</Text>
          <Text>{assistantBuffer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function MessageRow({
  item,
  theme,
  outputStyle,
}: {
  item: TranscriptItem;
  theme: ReturnType<typeof useTheme>["theme"];
  outputStyle?: string;
}): React.JSX.Element {
  switch (item.role) {
    case "user":
      return (
        <Box marginTop={1} marginBottom={0}>
          <Text>
            <Text color={theme.colors.secondary} bold>{theme.icons.user}</Text>
            <Text>{item.text}</Text>
          </Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1} marginBottom={0} flexDirection="column">
          <Text color={theme.colors.success} bold>{theme.icons.assistant}</Text>
          <Box marginLeft={2} flexDirection="column">
            <Markdown content={item.text} />
          </Box>
        </Box>
      );

    case "tool":
    case "tool_result":
      return <ToolCallDisplay item={item} outputStyle={outputStyle} />;

    case "system":
      return (
        <Box marginTop={0}>
          <Text>
            <Text color={theme.colors.warning}>{theme.icons.system}</Text>
            <Text color={theme.colors.warning}>{item.text}</Text>
          </Text>
        </Box>
      );

    case "log":
      return (
        <Box>
          <Text dimColor>{item.text}</Text>
        </Box>
      );

    default:
      return (
        <Box>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}
