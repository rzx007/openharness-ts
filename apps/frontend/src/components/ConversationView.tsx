import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "../theme/ThemeContext";
import type { TranscriptItem } from "../types";
import { Markdown } from "./Markdown";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { WelcomeBanner } from "./WelcomeBanner";

export function ConversationView({
  items,
  assistantBuffer,
  showWelcome,
}: {
  items: TranscriptItem[];
  assistantBuffer: string;
  showWelcome: boolean;
}): React.JSX.Element {
  const { theme } = useTheme();
  const visible = items.slice(-40);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {showWelcome && items.length === 0 ? <WelcomeBanner /> : null}

      {visible.map((item, index) => (
        <MessageRow key={index} item={item} theme={theme} />
      ))}

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

function MessageRow({ item, theme }: { item: TranscriptItem; theme: ReturnType<typeof useTheme>["theme"] }): React.JSX.Element {
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
      return <ToolCallDisplay item={item} />;

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
