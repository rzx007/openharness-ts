import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  getInlineDisplayText,
  getInlineFallbackText,
  getTableCellDisplayText,
  getListItemInlineTokens,
  getListItemBlockTokens,
  type Token,
  type Tokens,
} from "./markdownParser";

/** 取第一个 token，并对空结果做断言（测试辅助）。 */
function first(tokens: Token[]): Token {
  const token = tokens[0];
  if (!token) {
    throw new Error("expected at least one markdown token");
  }
  return token;
}

describe("parseMarkdown - headings", () => {
  it("parses heading depth and text", () => {
    const token = first(parseMarkdown("## Hello World"));
    expect(token.type).toBe("heading");
    const h = token as Tokens.Heading;
    expect(h.depth).toBe(2);
    expect(h.text).toBe("Hello World");
  });

  it("distinguishes h1 from h3", () => {
    const tokens = parseMarkdown("# A\n\n### B");
    const headings = tokens.filter((t) => t.type === "heading") as Tokens.Heading[];
    expect(headings.map((h) => h.depth)).toEqual([1, 3]);
  });
});

describe("parseMarkdown - lists", () => {
  it("parses an unordered list", () => {
    const token = first(parseMarkdown("- one\n- two\n- three"));
    expect(token.type).toBe("list");
    const l = token as Tokens.List;
    expect(l.ordered).toBe(false);
    expect(l.items.map((i) => i.text)).toEqual(["one", "two", "three"]);
  });

  it("parses an ordered list with its start index", () => {
    const token = first(parseMarkdown("3. a\n4. b"));
    const l = token as Tokens.List;
    expect(l.ordered).toBe(true);
    expect(Number(l.start)).toBe(3);
    expect(l.items).toHaveLength(2);
  });

  it("extracts inline tokens from list items", () => {
    const token = first(parseMarkdown("- plain **bold** tail"));
    const l = token as Tokens.List;
    const inline = getListItemInlineTokens(l.items[0]!);
    expect(inline.some((t) => t.type === "strong")).toBe(true);
    expect(getInlineDisplayText(inline)).toBe("plain bold tail");
  });

  it("keeps a nested unordered sublist as a block child (not dropped)", () => {
    const token = first(parseMarkdown("- a\n  - a1\n  - a2"));
    const l = token as Tokens.List;
    const parent = l.items[0]!;

    // 行内只取本项文本，不把嵌套 list 摊平进来。
    expect(getInlineDisplayText(getListItemInlineTokens(parent))).toBe("a");

    // 嵌套 list 必须作为块级子节点保留下来，子项 a1/a2 完整可见。
    const blocks = getListItemBlockTokens(parent);
    const sublist = blocks.find((t) => t.type === "list") as
      | Tokens.List
      | undefined;
    expect(sublist).toBeDefined();
    expect(sublist!.ordered).toBe(false);
    expect(sublist!.items.map((i) => i.text)).toEqual(["a1", "a2"]);
  });

  it("keeps a nested ordered sublist and preserves its start index", () => {
    const token = first(parseMarkdown("- top\n  2. x\n  3. y"));
    const l = token as Tokens.List;
    const blocks = getListItemBlockTokens(l.items[0]!);
    const sublist = blocks.find((t) => t.type === "list") as
      | Tokens.List
      | undefined;
    expect(sublist).toBeDefined();
    expect(sublist!.ordered).toBe(true);
    expect(Number(sublist!.start)).toBe(2);
    expect(sublist!.items.map((i) => i.text)).toEqual(["x", "y"]);
  });

  it("preserves multiple levels of nesting (at least two deep)", () => {
    const token = first(parseMarkdown("- a\n  - b\n    - c"));
    const l = token as Tokens.List;

    const lvl1 = getListItemBlockTokens(l.items[0]!).find(
      (t) => t.type === "list",
    ) as Tokens.List;
    expect(lvl1.items.map((i) => getInlineDisplayText(getListItemInlineTokens(i)))).toEqual([
      "b",
    ]);

    const lvl2 = getListItemBlockTokens(lvl1.items[0]!).find(
      (t) => t.type === "list",
    ) as Tokens.List;
    expect(lvl2).toBeDefined();
    expect(lvl2.items.map((i) => i.text)).toEqual(["c"]);
  });

  it("returns no block children for a flat list item", () => {
    const token = first(parseMarkdown("- just text"));
    const l = token as Tokens.List;
    expect(getListItemBlockTokens(l.items[0]!)).toEqual([]);
  });
});

describe("parseMarkdown - code blocks", () => {
  it("captures fenced code language and body", () => {
    const token = first(parseMarkdown("```ts\nconst x = 1;\nconsole.log(x);\n```"));
    expect(token.type).toBe("code");
    const c = token as Tokens.Code;
    expect(c.lang).toBe("ts");
    expect(c.text).toBe("const x = 1;\nconsole.log(x);");
  });

  it("captures fenced code with no language", () => {
    const token = first(parseMarkdown("```\nraw text\n```"));
    const c = token as Tokens.Code;
    expect(c.lang ?? "").toBe("");
    expect(c.text).toBe("raw text");
  });
});

describe("parseMarkdown - tables", () => {
  it("parses header and rows", () => {
    const token = first(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"));
    expect(token.type).toBe("table");
    const t = token as Tokens.Table;
    expect(t.header.map(getTableCellDisplayText)).toEqual(["a", "b"]);
    expect(t.rows.map((r) => r.map(getTableCellDisplayText))).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips inline markdown when computing cell display text", () => {
    const token = first(parseMarkdown("| `code` | **x** |\n|---|---|\n| y | z |"));
    const t = token as Tokens.Table;
    expect(t.header.map(getTableCellDisplayText)).toEqual(["code", "x"]);
  });
});

describe("getInlineDisplayText - inline styles", () => {
  function inlineOf(md: string) {
    const token = first(parseMarkdown(md));
    return (token as Tokens.Paragraph).tokens;
  }

  it("flattens bold, italic, strikethrough and code spans to plain text", () => {
    expect(getInlineDisplayText(inlineOf("**b** _i_ ~~s~~ `c`"))).toBe("b i s c");
  });

  it("uses link label, falling back to href", () => {
    expect(getInlineDisplayText(inlineOf("[label](https://x.test)"))).toBe("label");
    expect(getInlineDisplayText(inlineOf("<https://x.test>"))).toBe("https://x.test");
  });

  it("renders image alt text", () => {
    expect(getInlineDisplayText(inlineOf("![alt](https://x.test/i.png)"))).toBe("alt");
  });
});

describe("getInlineFallbackText", () => {
  it("returns the text field when present", () => {
    const token = first(parseMarkdown("hello"));
    const p = token as Tokens.Paragraph;
    expect(getInlineFallbackText(p.tokens[0]!)).toBe("hello");
  });
});

describe("parseMarkdown - blockquote", () => {
  it("preserves nested list structure inside a blockquote", () => {
    const token = first(parseMarkdown("> - first\n> - second"));
    expect(token.type).toBe("blockquote");
    const bq = token as Tokens.Blockquote;
    const list = bq.tokens.find((t) => t.type === "list") as Tokens.List | undefined;
    expect(list).toBeDefined();
    expect(list!.items.map((i) => i.text)).toEqual(["first", "second"]);
  });
});
