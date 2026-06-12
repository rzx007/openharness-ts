import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Session } from "./Session";
import { Footer } from "./Footer";
import { TodoPanel } from "../../components/TodoPanel";
import { SwarmPanel } from "../../components/SwarmPanel";
import type { TranscriptItem, McpServerSnapshot } from "../../types";

// ─── Test 1: Session renders mixed transcript ──────────────────────────────

test("Session renders mixed transcript items", async () => {
  const items: TranscriptItem[] = [
    { role: "user", text: "Hello from user" },
    { role: "assistant", text: "Some assistant response text here" },
    {
      role: "tool",
      text: "",
      tool_name: "bash_tool",
      tool_input: { command: "echo hello" },
    },
    { role: "tool_result", text: "hello\nmore output" },
    { role: "system", text: "System log message" },
  ];

  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Session items={items} assistantBuffer="" />
    </ThemeProvider>,
    { width: 100, height: 40 },
  );

  await renderOnce();
  // markdown 解析是异步的：轮询渲染直到 assistant 内容出现
  for (let i = 0; i < 40; i++) {
    await renderOnce();
    await new Promise((r) => setTimeout(r, 20));
    if (captureCharFrame().includes("assistant response")) break;
  }
  const frame = captureCharFrame();

  // User text present
  expect(frame).toContain("Hello from user");

  // assistant markdown rendered (async parse, polled above)
  expect(frame).toContain("Some assistant response text here");

  // Tool name present
  expect(frame).toContain("bash_tool");

  // Tool input summary (command) present
  expect(frame).toContain("echo hello");

  // tool_result first line
  expect(frame).toContain("hello");

  // system text present
  expect(frame).toContain("System log message");

  renderer.destroy();
});

// ─── Test 2: assistantBuffer shows streaming content ─────────────────────

test("Session renders streaming assistantBuffer", async () => {
  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Session items={[]} assistantBuffer="Streaming content here" />
    </ThemeProvider>,
    { width: 100, height: 20 },
  );

  await renderOnce();
  await waitForFrame((f) => f.includes("Streaming content here"), { maxPasses: 30 });
  const frame = captureCharFrame();

  expect(frame).toContain("Streaming content here");

  renderer.destroy();
});

// ─── Test 3: Footer renders plan mode, tokens, MCP count, version ────────

test("Footer renders plan indicator, MCP count, tokens, version", async () => {
  const status: Record<string, unknown> = {
    model: "claude-3-5-sonnet",
    permission_mode: "plan",
    input_tokens: 12345,
    output_tokens: 678,
  };

  const mcpServers: McpServerSnapshot[] = [
    { name: "server-a", state: "connected" },
    { name: "server-b", state: "connected" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Footer status={status} mcpServers={mcpServers} version="1.2.3" />
    </ThemeProvider>,
    { width: 120, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Plan mode indicator
  expect(frame).toContain("[PLAN]");

  // MCP servers count
  expect(frame).toContain("2 MCP");

  // Tokens: 12345 → "12.3k↓", 678 → "678↑"
  expect(frame).toContain("12.3k");
  expect(frame).toContain("678");

  // Version
  expect(frame).toContain("1.2.3");

  renderer.destroy();
});

// ─── Test 4a: TodoPanel renders compact summary ───────────────────────────

test("TodoPanel renders compact summary with first pending item", async () => {
  const markdown = [
    "- [x] First done task",
    "- [ ] Second pending task",
    "- [ ] Third pending task",
  ].join("\n");

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <TodoPanel markdown={markdown} />
    </ThemeProvider>,
    { width: 80, height: 10 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  // Shows done/total counter
  expect(frame).toContain("1/3");

  // Shows first pending item
  expect(frame).toContain("Second pending task");

  renderer.destroy();
});

test("TodoPanel shows all-done message when all checked", async () => {
  const markdown = [
    "- [x] Done task one",
    "- [x] Done task two",
  ].join("\n");

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <TodoPanel markdown={markdown} />
    </ThemeProvider>,
    { width: 80, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("all done");

  renderer.destroy();
});

test("TodoPanel returns null for empty markdown", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box>
        <text>BEFORE</text>
        <TodoPanel markdown="" />
        <text>AFTER</text>
      </box>
    </ThemeProvider>,
    { width: 80, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("BEFORE");
  expect(frame).toContain("AFTER");
  // No todo indicator rendered
  expect(frame).not.toContain("▣");

  renderer.destroy();
});

// ─── Test 4b: SwarmPanel renders teammates and notifications ──────────────

test("SwarmPanel renders teammate list and recent notifications", async () => {
  const teammates = [
    { name: "agent-alpha", status: "running" as const, duration: 90, task: "Fix the login bug" },
    { name: "agent-beta", status: "done" as const, duration: 45 },
  ];
  const notifications = [
    { from: "agent-alpha", message: "Starting work", timestamp: 1 },
    { from: "agent-beta", message: "All done now", timestamp: 2 },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <SwarmPanel teammates={teammates} notifications={notifications} />
    </ThemeProvider>,
    { width: 100, height: 15 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("agent-alpha");
  expect(frame).toContain("agent-beta");
  expect(frame).toContain("Fix the login bug");
  // duration 90s = 1m30s
  expect(frame).toContain("1m30s");
  expect(frame).toContain("All done now");

  renderer.destroy();
});

test("SwarmPanel returns null when empty", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box>
        <text>WRAP</text>
        <SwarmPanel teammates={[]} notifications={[]} />
      </box>
    </ThemeProvider>,
    { width: 80, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("WRAP");
  // No agent rendered
  expect(frame).not.toContain("agent-");

  renderer.destroy();
});
