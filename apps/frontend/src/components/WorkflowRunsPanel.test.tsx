import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../theme/ThemeContext";
import { WorkflowRunsPanel } from "./WorkflowRunsPanel";
import type { WorkflowTuiState } from "../types";

const state: WorkflowTuiState = {
  selectedRunId: "wf-running",
  runs: [
    {
      runId: "wf-running",
      status: "running",
      summary: "Research is still running",
      mode: "pipeline",
      totalTasks: 2,
      completedTasks: 0,
      failedTasks: 0,
      pendingTasks: 1,
      runningTasks: 1,
      blockedTasks: 0,
      needsReconciliation: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  snapshot: { runId: "wf-running" },
  tasks: [
    { taskId: "research", status: "running", summary: "Waiting for task task_2", dependencies: [] },
    { taskId: "summarize", status: "pending", summary: "Summarize result", dependencies: ["research"] },
  ],
  timeline: [
    { timestamp: 1, type: "workflow_started", status: "running", summary: "Workflow started" },
    { timestamp: 2, type: "task_started", taskId: "research", status: "running", summary: "Research started" },
  ],
  filters: { taskId: "research" },
  available: {
    taskIds: ["research", "summarize"],
    eventTypes: ["workflow_started", "task_started"],
    statuses: ["running", "pending"],
  },
  reconciliation: {
    needed: true,
    summary: "1 action needed",
    actions: [
      {
        actionId: "reconcile-research",
        issueIds: ["issue-1"],
        taskId: "reconcile",
        description: "Reconcile research output",
        prompt: "Reconcile it",
        writeScope: ["."],
        dependsOn: [],
      },
    ],
  },
};

test("WorkflowRunsPanel renders run list, detail, filters, timeline, and reconcile actions", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <WorkflowRunsPanel
        state={state}
        onRefresh={() => {}}
        onSelectRun={() => {}}
        onSetFilter={() => {}}
        onClearFilters={() => {}}
        onCancelRun={() => {}}
        onSelectReconcileAction={() => {}}
      />
    </ThemeProvider>,
    { width: 90, height: 36 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("Workflow Runs");
  expect(frame).toContain("wf-running");
  expect(frame).toContain("running");
  expect(frame).toContain("task=research");
  expect(frame).toContain("summarize");
  expect(frame).toContain("TIMELINE");
  expect(frame).toContain("task_started");
  expect(frame).toContain("RECONCILE");
  expect(frame).toContain("reconcile-research");

  renderer.destroy();
});

test("WorkflowRunsPanel handles empty state", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <WorkflowRunsPanel
        state={{ runs: [], tasks: [], timeline: [], filters: {}, available: { taskIds: [], eventTypes: [], statuses: [] } }}
        onRefresh={() => {}}
        onSelectRun={() => {}}
        onSetFilter={() => {}}
        onClearFilters={() => {}}
        onCancelRun={() => {}}
        onSelectReconcileAction={() => {}}
      />
    </ThemeProvider>,
    { width: 80, height: 12 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("No persisted workflow runs");

  renderer.destroy();
});
