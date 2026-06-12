import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { highlight } from "cli-highlight";

import { useTheme } from "../theme/ThemeContext";
import type { ThemeConfig } from "../theme/builtinThemes";
import {
  parseMarkdown,
  getInlineFallbackText,
  getTableCellDisplayText,
  getListItemInlineTokens,
  getListItemBlockTokens,
  type Token,
  type Tokens,
} from "./markdownParser";

/**
 * 代码块语法高亮（cli-highlight → ANSI，Ink Text 原样透传）。
 * 未知语言/高亮器异常回退原文，绝不让渲染崩。
 */
export function highlightCode(text: string, lang?: string): string {
  // 无语言不猜：highlight.js 的 auto-detect 会给纯文本/日志乱着色（"to"、
  // "some" 这类词被当关键字），无 lang 围栏一律原样返回。
  if (!lang) return text;
  try {
    return highlight(text, { language: lang, ignoreIllegals: true });
  } catch {
    return text;
  }
}

// 行内 token 渲染：返回一组 <Text> 元素。
function renderInline(
  tokens: Token[] | undefined,
  theme: ThemeConfig,
): React.ReactNode {
  if (!tokens || tokens.length === 0) {
    return null;
  }
  return tokens.map((token, i) => {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        // text token 自身也可能带行内子节点（如列表项内容）。
        if (t.tokens && t.tokens.length > 0) {
          return (
            <React.Fragment key={i}>
              {renderInline(t.tokens, theme)}
            </React.Fragment>
          );
        }
        return <Text key={i}>{t.text}</Text>;
      }
      case "strong": {
        const s = token as Tokens.Strong;
        return (
          <Text key={i} bold>
            {renderInline(s.tokens, theme)}
          </Text>
        );
      }
      case "em": {
        const e = token as Tokens.Em;
        return (
          <Text key={i} italic>
            {renderInline(e.tokens, theme)}
          </Text>
        );
      }
      case "del": {
        const d = token as Tokens.Del;
        return (
          <Text key={i} strikethrough>
            {renderInline(d.tokens, theme)}
          </Text>
        );
      }
      case "codespan": {
        const c = token as Tokens.Codespan;
        return (
          <Text key={i} color={theme.colors.accent}>
            {c.text}
          </Text>
        );
      }
      case "link": {
        const l = token as Tokens.Link;
        const label = l.text || l.href;
        return (
          <Text key={i} color={theme.colors.info} underline>
            {label}
          </Text>
        );
      }
      case "image": {
        const image = token as Tokens.Image;
        return <Text key={i}>{image.text || image.href}</Text>;
      }
      case "br":
        return <Text key={i}>{"\n"}</Text>;
      case "escape": {
        const es = token as Tokens.Escape;
        return <Text key={i}>{es.text}</Text>;
      }
      default:
        return <Text key={i}>{getInlineFallbackText(token)}</Text>;
    }
  });
}

function renderBlocks(
  tokens: Token[] | undefined,
  theme: ThemeConfig,
): React.ReactNode {
  if (!tokens || tokens.length === 0) {
    return null;
  }

  return tokens.map((token, i) => (
    <MarkdownBlock key={i} token={token} theme={theme} />
  ));
}

function MarkdownBlock({
  token,
  theme,
}: {
  token: Token;
  theme: ThemeConfig;
}): React.JSX.Element | null {
  switch (token.type) {
    case "heading": {
      const h = token as Tokens.Heading;
      const headingColors: string[] = [
        theme.colors.primary,
        theme.colors.secondary,
        theme.colors.accent,
        theme.colors.info,
        theme.colors.muted,
        theme.colors.muted,
      ];
      const color = headingColors[h.depth - 1] ?? theme.colors.primary;
      const isMajor = h.depth <= 2;
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={color} bold={isMajor} underline={h.depth === 1}>
            {renderInline(h.tokens, theme)}
          </Text>
          {h.depth === 1 ? (
            <Text color={color} dimColor>
              {"━".repeat(32)}
            </Text>
          ) : null}
        </Box>
      );
    }

    case "paragraph": {
      const p = token as Tokens.Paragraph;
      return (
        <Box marginTop={0} flexWrap="wrap">
          <Text>{renderInline(p.tokens, theme)}</Text>
        </Box>
      );
    }

    case "code": {
      const c = token as Tokens.Code;
      const lines = highlightCode(c.text, c.lang).split("\n");
      return (
        <Box
          flexDirection="column"
          marginTop={1}
          marginLeft={2}
          borderStyle="round"
          paddingX={1}
          borderColor={theme.colors.muted}
        >
          {c.lang ? <Text dimColor>{c.lang}</Text> : null}
          {lines.map((line, i) => (
            // 有 lang：ANSI 已着色不叠主题色；无 lang：保留原主题 accent。
            <Text key={i} color={c.lang ? undefined : theme.colors.accent}>
              {line}
            </Text>
          ))}
        </Box>
      );
    }

    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      return (
        <Box flexDirection="column" marginTop={0} marginLeft={0}>
          {bq.tokens.map((t, i) => (
            <Box key={i} flexDirection="row">
              <Text color={theme.colors.muted}>{"│ "}</Text>
              <Box flexDirection="column" flexGrow={1}>
                {renderBlocks([t], theme)}
              </Box>
            </Box>
          ))}
        </Box>
      );
    }

    case "list": {
      const l = token as Tokens.List;
      return (
        <Box flexDirection="column" marginTop={0} marginLeft={2}>
          {l.items.map((item, i) => {
            const inlineTokens = getListItemInlineTokens(item);
            // 块级子节点（尤其嵌套 list，以及 code/blockquote 等）递归交给块级渲染，
            // marginLeft 缩进体现层级；否则嵌套子项会被静默丢弃。
            const blockTokens = getListItemBlockTokens(item);
            const bullet = l.ordered ? `${(Number(l.start) || 1) + i}. ` : "• ";
            return (
              <Box key={i} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={theme.colors.primary}>{bullet}</Text>
                  <Box flexGrow={1}>
                    <Text>
                      {inlineTokens.length > 0
                        ? renderInline(inlineTokens, theme)
                        : item.text}
                    </Text>
                  </Box>
                </Box>
                {blockTokens.length > 0 ? renderBlocks(blockTokens, theme) : null}
              </Box>
            );
          })}
        </Box>
      );
    }

    case "hr":
      return (
        <Box marginTop={1}>
          <Text dimColor>{"─".repeat(48)}</Text>
        </Box>
      );

    case "space":
      return null;

    case "table": {
      const t = token as Tokens.Table;
      const headerTexts = t.header.map(getTableCellDisplayText);
      const rowTexts = t.rows.map((row) => row.map(getTableCellDisplayText));
      // 用 stringWidth 计算列宽，正确处理 CJK 与宽字符。
      const colCount = t.header.length;
      const colWidths: number[] = headerTexts.map((cellText) =>
        stringWidth(cellText),
      );
      for (const row of rowTexts) {
        for (let c = 0; c < colCount; c++) {
          colWidths[c] = Math.max(colWidths[c] ?? 0, stringWidth(row[c] ?? ""));
        }
      }
      const trailing = (cellText: string, c: number): string =>
        " ".repeat(Math.max(0, (colWidths[c] ?? 0) - stringWidth(cellText)));
      const top = "┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐";
      const mid = "├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤";
      const bot = "└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘";
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          <Text color={theme.colors.muted}>{top}</Text>
          <Text>
            <Text color={theme.colors.muted}>{"│"}</Text>
            {t.header.map((cell, c) => (
              <React.Fragment key={c}>
                <Text color={theme.colors.primary} bold>
                  {" "}
                  {renderInline(cell.tokens, theme)}
                  {trailing(headerTexts[c] ?? "", c)}{" "}
                </Text>
                <Text color={theme.colors.muted}>{"│"}</Text>
              </React.Fragment>
            ))}
          </Text>
          <Text color={theme.colors.muted}>{mid}</Text>
          {t.rows.map((row, i) => (
            <Text key={i}>
              <Text color={theme.colors.muted}>{"│"}</Text>
              {row.map((cell, c) => (
                <React.Fragment key={c}>
                  <Text>
                    {" "}
                    {renderInline(cell.tokens, theme)}
                    {trailing(rowTexts[i]?.[c] ?? "", c)}{" "}
                  </Text>
                  <Text color={theme.colors.muted}>{"│"}</Text>
                </React.Fragment>
              ))}
            </Text>
          ))}
          <Text color={theme.colors.muted}>{bot}</Text>
        </Box>
      );
    }

    default:
      if ((token as Token).raw) {
        return <Text>{(token as Token).raw}</Text>;
      }
      return null;
  }
}

/**
 * 把 Markdown 文本渲染为一组 Ink 元素。
 *
 * 覆盖：标题、有序/无序列表、代码块（带语言标签）、行内代码、粗体/斜体/删除线、
 * 引用块、链接、表格、分隔线。终端宽度自适应交给 Ink 的 flex 布局；表格列宽用
 * stringWidth 处理宽字符对齐。
 */
export const Markdown = React.memo(function Markdown({
  content,
}: {
  content: string;
}): React.JSX.Element {
  const { theme } = useTheme();
  const tokens = React.useMemo(() => parseMarkdown(content), [content]);
  return <Box flexDirection="column">{renderBlocks(tokens, theme)}</Box>;
});
