import { lexer, type Token, type Tokens } from "marked";

/**
 * 纯函数 Markdown 解析层。
 *
 * 这里只负责把 Markdown 文本转成结构化 token，并提供把行内 token 还原为
 * 纯文本的辅助函数（用于表格列宽计算、未知 token 兜底、以及单元测试）。
 * 不依赖 React/Ink，便于做纯函数单测。
 */

export type { Token, Tokens };

/** 把 Markdown 字符串解析为 marked 的块级 token 列表。 */
export function parseMarkdown(content: string): Token[] {
  return lexer(content);
}

/** 取某个 token 的兜底纯文本（优先 text 字段，否则用原始 raw）。 */
export function getInlineFallbackText(token: Token): string {
  if ("text" in token && typeof token.text === "string") {
    return token.text;
  }
  return token.raw;
}

/**
 * 把一组行内 token 还原为可显示的纯文本（去掉 markdown 语法标记）。
 * 用于表格列宽测量及 ink 无法表达的场景兜底。
 */
export function getInlineDisplayText(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) {
    return "";
  }

  return tokens
    .map((token) => {
      switch (token.type) {
        case "text": {
          const t = token as Tokens.Text;
          return t.tokens && t.tokens.length > 0
            ? getInlineDisplayText(t.tokens)
            : t.text;
        }
        case "strong":
        case "em":
        case "del":
          return getInlineDisplayText(
            (token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens,
          );
        case "codespan":
          return (token as Tokens.Codespan).text;
        case "link": {
          const l = token as Tokens.Link;
          return l.text || l.href;
        }
        case "image": {
          const image = token as Tokens.Image;
          return image.text || image.href;
        }
        case "br":
          return "\n";
        case "escape":
          return (token as Tokens.Escape).text;
        default:
          return getInlineFallbackText(token);
      }
    })
    .join("");
}

/** 取表格单元格的显示文本，行内为空时回退到 cell.text。 */
export function getTableCellDisplayText(cell: Tokens.TableCell): string {
  const displayText = getInlineDisplayText(cell.tokens);
  return displayText.length > 0 ? displayText : cell.text;
}

/**
 * 列表项里承载行内文本的子 token 类型。
 *
 * - 紧凑列表 (tight): item.tokens = [{type:'text', tokens:[...inline]}]
 * - 松散列表 (loose): item.tokens = [{type:'paragraph', tokens:[...inline]}]
 * 其余类型（list / code / blockquote 等）视为块级子节点，交给块级渲染递归处理。
 */
const LIST_ITEM_INLINE_CONTAINER_TYPES = new Set<string>(["text", "paragraph"]);

/**
 * 列表项的行内 token 提取。
 *
 * 只摊平 text / paragraph 这类“行内容器”子节点里的内层 inline token；
 * 嵌套 list 等块级子节点不在此返回（见 getListItemBlockTokens）。
 */
export function getListItemInlineTokens(item: Tokens.ListItem): Token[] {
  return item.tokens.flatMap((t) =>
    LIST_ITEM_INLINE_CONTAINER_TYPES.has(t.type) && "tokens" in t && t.tokens
      ? (t.tokens as Token[])
      : [],
  );
}

/**
 * 列表项的块级子 token 提取。
 *
 * marked 对嵌套列表的结构是 item.tokens = ['text', 'list', ...]，其中嵌套的
 * `list` 用 `.items`（而非 `.tokens`）承载内容。这些块级容器（list / code /
 * blockquote 等）应原样交给块级渲染逻辑递归处理，以免子项被静默丢弃。
 */
export function getListItemBlockTokens(item: Tokens.ListItem): Token[] {
  return item.tokens.filter(
    (t) => !LIST_ITEM_INLINE_CONTAINER_TYPES.has(t.type),
  );
}
