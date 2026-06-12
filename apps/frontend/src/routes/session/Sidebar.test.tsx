import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Sidebar, computeModifiedFiles } from "./Sidebar";
import type { TranscriptItem } from "../../types";

test("computeModifiedFiles extracts files from Edit/Write tool calls", () => {
  const items: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "x", new_string: "y" } },
    { role: "tool", text: "", tool_name: "Write", tool_input: { path: "src/b.ts", content: "new content" } },
    { role: "tool", text: "", tool_name: "bash_tool", tool_input: { command: "echo hi" } },
  ];
  const files = computeModifiedFiles(items);
  expect(files.map((f) => f.path)).toContain("src/a.ts");
  expect(files.map((f) => f.path)).toContain("src/b.ts");
  expect(files.length).toBe(2);
});

test("computeModifiedFiles deduplicates same path", () => {
  const items: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "x", new_string: "y" } },
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/a.ts", old_string: "y", new_string: "z" } },
  ];
  const files = computeModifiedFiles(items);
  expect(files.length).toBe(1);
  expect(files[0]!.path).toBe("src/a.ts");
});

test("Sidebar renders session info", async () => {
  const status = { permission_mode: "default", model: "claude-opus-4-5", input_tokens: 1234, output_tokens: 56 };

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={status}
        transcript={[]}
        mcpServers={[]}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("claude-opus-4-5");
  expect(frame).toContain("default");

  renderer.destroy();
});

test("Sidebar renders MCP server names", async () => {
  const mcpServers = [
    { name: "filesystem", state: "connected", tool_count: 5 },
    { name: "github", state: "error" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={{}}
        transcript={[]}
        mcpServers={mcpServers}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("filesystem");
  expect(frame).toContain("github");

  renderer.destroy();
});

test("Sidebar renders modified files from transcript", async () => {
  const transcript: TranscriptItem[] = [
    { role: "tool", text: "", tool_name: "Edit", tool_input: { path: "src/main.ts", old_string: "a", new_string: "b" } },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={{}}
        transcript={transcript}
        mcpServers={[]}
        todoMarkdown=""
        swarmTeammates={[]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 40, height: 20 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("main.ts");

  renderer.destroy();
});
