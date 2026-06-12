import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { ToolDiff, truncatePatch } from "./ToolDiff";

// ─── truncatePatch unit tests (no render needed) ─────────────────────────────

test("truncatePatch keeps short patch intact", () => {
  const patch = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  expect(truncatePatch(patch, 20)).toBe(patch);
});

test("truncatePatch truncates long patch and appends summary", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const patch = lines.join("\n");
  const result = truncatePatch(patch, 20);
  const resultLines = result.split("\n");
  expect(resultLines.length).toBe(21); // 20 kept + 1 summary
  expect(resultLines[20]).toContain("more lines");
});

// ─── ToolDiff render tests ────────────────────────────────────────────────────

test("ToolDiff renders diff for Edit tool", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={80} height={20}>
        <ToolDiff
          filePath="src/foo.ts"
          oldText="const x = 1;\n"
          newText="const x = 2;\n"
        />
      </box>
    </ThemeProvider>,
    { width: 80, height: 20 },
  );

  await renderOnce();
  // Poll for async diff render
  for (let i = 0; i < 20; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    const f = captureCharFrame();
    if (f.includes("+") || f.includes("-")) break;
  }
  const frame = captureCharFrame();
  // The <diff> element renders diff markers but not the filename header
  expect(frame).toContain("+");
  renderer.destroy();
});

test("ToolDiff renders all-added patch for Write tool (oldText='')", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={80} height={20}>
        <ToolDiff
          filePath="src/new.ts"
          oldText=""
          newText="export const hello = 'world';\n"
        />
      </box>
    </ThemeProvider>,
    { width: 80, height: 20 },
  );

  await renderOnce();
  for (let i = 0; i < 20; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    const f = captureCharFrame();
    if (f.includes("+")) break;
  }
  const frame = captureCharFrame();
  // The <diff> element renders diff markers but not the filename header
  expect(frame).toContain("+");
  renderer.destroy();
});
