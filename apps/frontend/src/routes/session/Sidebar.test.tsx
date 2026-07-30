import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Sidebar, computeModifiedFiles, computeWorkflowPanel } from "./Sidebar";
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

test("Sidebar renders detailed swarm teammate state", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <Sidebar
        status={{}}
        transcript={[]}
        mcpServers={[]}
        todoMarkdown=""
        swarmTeammates={[
          { name: "task_2", status: "running", duration: 305, task: "worker@default" },
          { name: "task_1", status: "done", duration: 45, task: "research@default" },
        ]}
        swarmNotifications={[]}
      />
    </ThemeProvider>,
    { width: 44, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("SWARM");
  expect(frame).toContain("task_2");
  expect(frame).toContain("running");
  expect(frame).toContain("5m5s");
  expect(frame).toContain("worker@default");
  expect(frame).toContain("research@default");

  renderer.destroy();
});

test("computeWorkflowPanel reads workflow run snapshots", () => {
  const snapshotPayload = {
    snapshot: {
      runId: "wf-demo",
      status: "running",
      summary: "Workflow still running",
      plan: {
        mode: "pipeline",
        tasks: [
          { id: "research", description: "Inspect code" },
          { id: "summarize", description: "Summarize result" },
        ],
      },
      results: {},
      runningTaskIds: ["research"],
      runningTasks: {
        research: { taskId: "research", summary: "Waiting for task task_2" },
      },
      pendingTaskIds: ["summarize"],
      blockedTaskIds: [],
      blockedTasks: {},
    },
  };
  const escaped = JSON.stringify(snapshotPayload).replace(/"/g, "&quot;");
  const transcript: TranscriptItem[] = [{
    role: "tool",
    text: `<workflow-run-snapshot><payload>${escaped}</payload></workflow-run-snapshot>`,
    tool_name: "Workflow",
  }];

  const panel = computeWorkflowPanel(transcript);

  expect(panel?.runId).toBe("wf-demo");
  expect(panel?.status).toBe("running");
  expect(panel?.mode).toBe("pipeline");
  expect(panel?.runningTasks).toBe(1);
  expect(panel?.pendingTasks).toBe(1);
  expect(panel?.tasks.map((task) => `${task.id}:${task.status}`)).toEqual([
    "research:running",
    "summarize:pending",
  ]);
});

test("Sidebar renders workflow state from transcript", async () => {
  const payload = {
    status: "completed",
    runId: "wf-done",
    summary: "Workflow completed",
    mode: "sequential",
    totalTasks: 2,
    completedTasks: 2,
    failedTasks: 0,
    needsReconciliation: true,
    tasks: [
      { taskId: "research", status: "completed", summary: "Inspected code" },
      { taskId: "verify", status: "completed", summary: "Checks passed" },
    ],
  };
  const escaped = JSON.stringify(payload).replace(/"/g, "&quot;");
  const transcript: TranscriptItem[] = [{
    role: "tool",
    text: `<workflow-notification><payload>${escaped}</payload></workflow-notification>`,
    tool_name: "Workflow",
  }];

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
    { width: 44, height: 30 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("WORKFLOW");
  expect(frame).toContain("wf-done");
  expect(frame).toContain("completed");
  expect(frame).toContain("needs reconciliation");
  expect(frame).toContain("research");
  expect(frame).toContain("Checks passed");

  renderer.destroy();
});
