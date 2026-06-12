import { test, expect, mock } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Prompt } from "./Prompt";
import type { Command } from "../../keymap/commands";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const noopRun = mock(() => undefined);

const sampleCommands: Command[] = [
  { id: "/theme", title: "Switch theme", run: mock(() => undefined) },
  { id: "/help", title: "Show help", run: mock(() => undefined) },
  { id: "/plan", title: "Plan mode", run: mock(() => undefined) },
];

function makePrompt(overrides: Partial<React.ComponentProps<typeof Prompt>> = {}) {
  return (
    <ThemeProvider>
      <Prompt
        busy={false}
        mode="default"
        model="claude-3-opus"
        history={[]}
        slashCommands={sampleCommands}
        onSubmit={mock(() => undefined)}
        onCycleMode={mock(() => undefined)}
        {...overrides}
      />
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Test 1: placeholder and meta row rendered on initial frame
// ---------------------------------------------------------------------------

test("renders placeholder and mode/model meta row", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    makePrompt(),
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Placeholder text
  expect(frame).toContain("Ask anything");

  // Meta info row: Default (mode label) + model
  expect(frame).toContain("Default");
  expect(frame).toContain("claude-3-opus");

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 2: typeText + pressEnter → onSubmit called with text, input cleared
// ---------------------------------------------------------------------------

test("typeText + pressEnter triggers onSubmit and clears input", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(makePrompt({ onSubmit }), { width: 80, height: 24 });

  await renderOnce();

  // Type "hello"
  await act(async () => {
    await mockInput.typeText("hello");
  });
  await renderOnce();

  // Press Enter to submit
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  // onSubmit should have been called with "hello"
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit.mock.calls[0]?.[0]).toBe("hello");

  // Wait for placeholder to reappear (input cleared)
  await waitForFrame((f) => f.includes("Ask anything"));
  const frame = captureCharFrame();
  expect(frame).toContain("Ask anything");

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 3: typing "/th" shows autocomplete with /theme; pressEnter runs command
// ---------------------------------------------------------------------------

test("slash prefix shows autocomplete; enter executes highlighted command", async () => {
  const onSubmit = mock((_line: string) => undefined);
  const themeRun = mock(() => undefined);
  const commands: Command[] = [
    { id: "/theme", title: "Switch theme", run: themeRun },
    { id: "/help", title: "Show help", run: mock(() => undefined) },
  ];

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      makePrompt({ onSubmit, slashCommands: commands }),
      { width: 80, height: 24 },
    );

  await renderOnce();

  // Type "/th" to trigger autocomplete for /theme
  await act(async () => {
    await mockInput.typeText("/th");
  });
  await waitForFrame((f) => f.includes("/theme"));

  const frameBefore = captureCharFrame();
  expect(frameBefore).toContain("/theme");

  // Press Enter — should run /theme command, NOT call onSubmit
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(themeRun).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();

  // Input should be cleared (placeholder back)
  await waitForFrame((f) => f.includes("Ask anything"));

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 4: busy=true → spinner + "working...", no submit on Enter
// ---------------------------------------------------------------------------

test("busy state shows spinner/working and ignores submit", async () => {
  const onSubmit = mock((_line: string) => undefined);

  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      makePrompt({ busy: true, onSubmit }),
      { width: 80, height: 24 },
    );

  await renderOnce();
  // Wait for the spinner/working text to appear
  await waitForFrame((f) => f.includes("working"));
  const frame = captureCharFrame();
  expect(frame).toContain("working");

  // Type and press Enter — should be a no-op
  await act(async () => {
    await mockInput.typeText("hello");
  });
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(onSubmit).not.toHaveBeenCalled();

  renderer.destroy();
});

// ---------------------------------------------------------------------------
// Test 5: empty input + pressUp shows last history entry
// ---------------------------------------------------------------------------

test("up arrow on empty input shows most recent history entry", async () => {
  const history = ["first command", "second command", "third command"];

  const { renderer, renderOnce, mockInput, waitForFrame } = await testRender(
    makePrompt({ history }),
    { width: 80, height: 24 },
  );

  await renderOnce();

  // Ensure input is empty (it is on mount), press Up
  await act(async () => {
    mockInput.pressArrow("up");
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  // Should show last history item
  await waitForFrame((f) => f.includes("third command"));

  renderer.destroy();
});
