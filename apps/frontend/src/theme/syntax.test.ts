import { test, expect } from "bun:test";
import { createSyntaxStyle } from "./syntax";
import { defaultTheme } from "./builtinThemes";

test("createSyntaxStyle returns a SyntaxStyle with theme colors", () => {
  const style = createSyntaxStyle(defaultTheme);
  expect(style).toBeDefined();
  // 关键 token 都注册了样式（含 default 兜底）
  for (const name of ["markup.heading", "comment", "string", "keyword", "default"]) {
    expect(style.getStyle(name)).toBeDefined();
  }
  const keyword = style.getStyle("keyword")!;
  const comment = style.getStyle("comment")!;
  expect(keyword.fg).toBeDefined();
  expect(comment.italic).toBe(true);
  // keyword(accent) 与 comment(muted) 应解析为不同颜色
  expect(JSON.stringify(keyword.fg)).not.toBe(JSON.stringify(comment.fg));
});
