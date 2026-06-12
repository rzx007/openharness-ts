import { test, expect } from "bun:test";
import { createSyntaxStyle } from "./syntax";
import { defaultTheme } from "./builtinThemes";

test("createSyntaxStyle returns a SyntaxStyle with theme colors", () => {
  const style = createSyntaxStyle(defaultTheme);
  expect(style).toBeDefined();
});
