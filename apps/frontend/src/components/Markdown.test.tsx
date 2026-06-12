import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

import { ThemeProvider } from "../theme/ThemeContext";
import { Markdown } from "./Markdown";

const stripAnsi = (value: string): string =>
  value.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");

function renderMarkdown(content: string): string {
  const { lastFrame } = render(
    <ThemeProvider initialTheme="default">
      <Markdown content={content} />
    </ThemeProvider>,
  );
  return stripAnsi(lastFrame() ?? "");
}

describe("Markdown component (smoke)", () => {
  it("renders headings, list bullets and inline text", () => {
    const out = renderMarkdown("# Title\n\n- alpha\n- beta");
    expect(out).toContain("Title");
    expect(out).toContain("• alpha");
    expect(out).toContain("• beta");
  });

  it("renders a table with aligned box-drawing borders", () => {
    const out = renderMarkdown("| a | bb |\n|---|----|\n| c | d |");
    const borderLines = out
      .split("\n")
      .filter((line) => /[┌├│└]/.test(line));
    expect(borderLines.length).toBeGreaterThanOrEqual(4);
    const widths = borderLines.map((line) => [...line.trimEnd()].length);
    // 表格各行可见宽度应一致（修剪行尾空白后比较）。
    expect(widths.every((w) => w === widths[0])).toBe(true);
  });

  it("renders a fenced code block including its content", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain("const x = 1;");
  });

  it("renders nested list children instead of dropping them", () => {
    const out = renderMarkdown("- a\n  - a1\n  - a2");
    expect(out).toContain("• a");
    // 修复前 a1/a2 会被静默丢弃。
    expect(out).toContain("• a1");
    expect(out).toContain("• a2");
  });

  it("renders a nested ordered sublist with its numbering", () => {
    const out = renderMarkdown("- top\n  2. x\n  3. y");
    expect(out).toContain("• top");
    expect(out).toContain("2. x");
    expect(out).toContain("3. y");
  });

  it("renders two levels of nested list", () => {
    const out = renderMarkdown("- a\n  - b\n    - c");
    expect(out).toContain("• a");
    expect(out).toContain("• b");
    expect(out).toContain("• c");
  });
});

describe("highlightCode (E.3 语法高亮)", () => {
  it("preserves code content for known languages (colors are TTY-dependent)", async () => {
    const { highlightCode } = await import("./Markdown.js");
    const out = highlightCode('const x = "hi";', "typescript");
    // 无 TTY 下 chalk 关色，只断内容保真；真 TUI 中输出含 ANSI。
    expect(stripAnsi(out)).toBe('const x = "hi";');
  });

  it("falls back to plain text for unknown languages and never throws", async () => {
    const { highlightCode } = await import("./Markdown.js");
    expect(highlightCode("plain stuff", "no-such-lang-xyz")).toContain("plain stuff");
    expect(highlightCode("no lang at all")).toContain("no lang at all");
  });
});
