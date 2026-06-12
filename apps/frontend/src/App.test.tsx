import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "./theme/ThemeContext";
import { AppView } from "./App";
import type { AppViewProps } from "./App";
import type { TranscriptItem } from "./types";

// Shared base props for AppView tests
const baseProps: AppViewProps = {
  transcript: [],
  assistantBuffer: "",
  ready: true,
  busy: false,
  status: { permission_mode: "default", model: "claude-opus-4-5" },
  mcpServers: [],
  todoMarkdown: "",
  swarmTeammates: [],
  swarmNotifications: [],
  version: null,
  history: [],
  slashCommands: [],
  onSubmit: () => {},
  onCycleMode: () => {},
  dialogOpen: false,
};

// ─── Test 1: ready=false → shows Connecting text ─────────────────────────────

test("AppView ready=false shows Connecting text", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} ready={false} />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("Connecting");

  renderer.destroy();
});

// ─── Test 2: empty transcript → Home route with logo + Footer ────────────────

test("AppView with empty transcript renders Home route and Footer", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  // logo is async-rendered (ascii-font); poll for it
  let frame = captureCharFrame();
  for (let i = 0; i < 30; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    frame = captureCharFrame();
    if (frame.includes("╭") || frame.includes("openharness")) break;
  }

  // Logo area present (box-drawing char from slick font, or fallback text)
  const hasLogo = frame.includes("╭") || frame.includes("openharness");
  expect(hasLogo).toBe(true);

  // ctrl+p hint rendered by Home component
  expect(frame).toContain("ctrl+p");

  renderer.destroy();
});

// ─── Test 3: user + assistant transcript → Session route with messages ────────

test("AppView with user+assistant transcript renders Session view", async () => {
  const transcript: TranscriptItem[] = [
    { role: "user", text: "Hello from the user" },
    { role: "assistant", text: "Hello from the assistant" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={transcript}
      />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  await renderOnce();
  // Poll until messages appear (markdown is async)
  let frame = captureCharFrame();
  for (let i = 0; i < 40; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    frame = captureCharFrame();
    if (frame.includes("Hello from the user") && frame.includes("assistant")) break;
  }

  expect(frame).toContain("Hello from the user");
  expect(frame).toContain("Hello from the assistant");

  // Footer renders model name from status
  expect(frame).toContain("claude-opus-4-5");

  renderer.destroy();
});

// ─── Test 4: dialogOpen=true → Prompt not rendered ──────────────────────────

test("AppView with dialogOpen=true does not render Prompt", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView {...baseProps} dialogOpen={true} />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // When dialog is open, the Prompt's placeholder text should not appear
  // The default placeholder includes "Ask anything"
  expect(frame).not.toContain("Ask anything");

  renderer.destroy();
});

// ─── Test 4b: draft survives dialog open/close (Prompt unmount/remount) ──────

test("AppView preserves prompt draft across dialog open/close", async () => {
  let setDialogOpen: (v: boolean) => void = () => {};

  function Harness() {
    const [open, setOpen] = React.useState(false);
    const [draft, setDraft] = React.useState("draft-text-123");
    setDialogOpen = setOpen;
    return (
      <AppView {...baseProps} dialogOpen={open} draft={draft} onDraftChange={setDraft} />
    );
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <Harness />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).toContain("draft-text-123");

  // Open dialog → Prompt unmounts, draft text disappears
  await act(async () => {
    setDialogOpen(true);
  });
  await waitForFrame((f) => !f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).not.toContain("draft-text-123");

  // Close dialog → Prompt remounts and restores the lifted draft
  await act(async () => {
    setDialogOpen(false);
  });
  await waitForFrame((f) => f.includes("draft-text-123"), { maxPasses: 30 });
  expect(captureCharFrame()).toContain("draft-text-123");

  renderer.destroy();
});

// ─── Test 5: busy=true with non-empty transcript → Session route (not Home) ──

test("AppView busy=true stays in Session route even with empty transcript", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={[]}
        assistantBuffer=""
        busy={true}
      />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // busy=true → session route; Prompt renders in busy/spinner state
  // Spinner or "working" text appears
  expect(frame).toContain("working");

  // Logo from Home should NOT be present (we're in session route)
  expect(frame).not.toContain("ctrl+p commands");

  renderer.destroy();
});

// ─── Test 6: assistantBuffer → Session route (streaming) ─────────────────────

test("AppView with assistantBuffer shows session route with streaming content", async () => {
  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <AppView
        {...baseProps}
        transcript={[]}
        assistantBuffer="Streaming text here"
      />
    </ThemeProvider>,
    { width: 100, height: 30 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("Streaming text here"), { maxPasses: 30 });
  const frame = captureCharFrame();

  expect(frame).toContain("Streaming text here");

  renderer.destroy();
});
