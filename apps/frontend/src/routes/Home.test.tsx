import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { Home } from "./Home";
import { ThemeProvider } from "../theme/ThemeContext";

test("Home renders logo area, children slot, and hint row (80x24)", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Home>
        <text>PROMPT_SLOT</text>
      </Home>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Children slot text rendered
  expect(frame).toContain("PROMPT_SLOT");

  // Hint row contains the key bindings
  expect(frame).toContain("ctrl+p commands");
  expect(frame).toContain("tab mode");

  // ascii-font "slick" renders box-drawing chars — verify logo is present
  // The slick font uses ╭ ╮ ╯ ╰ characters for its letter outlines
  expect(frame).toContain("╭");

  renderer.destroy();
});

test("Home narrow fallback text at width 30", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Home>
        <text>PROMPT_SLOT</text>
      </Home>
    </ThemeProvider>,
    { width: 30, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // At narrow width the Logo falls back to plain "openharness" text
  expect(frame).toContain("openharness");

  renderer.destroy();
});
