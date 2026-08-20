import { test, expect } from "bun:test";
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
  notice: "Reconciliation details are read-only with the current daemon Jobs API.",
};

test("WorkflowRunsPanel renders workflow details and reconciliation status without unsupported action hints", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <WorkflowRunsPanel
        state={state}
        onRefresh={() => {}}
        onSelectRun={() => {}}
        onSetFilter={() => {}}
        onClearFilters={() => {}}
        onCancelRun={() => {}}
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
  expect(frame).toContain("Reconciliation details are read-only");
  expect(frame).not.toContain("t/e/s filter");
  expect(frame).not.toContain("select action");
  expect(frame).not.toContain("follow-up");

  renderer.destroy();
});

test("WorkflowRunsPanel ignores unavailable event and reconciliation shortcuts while keeping task and status filters", async () => {
  const filters: Array<{ taskId?: string; status?: string }> = [];
  const legacyCalls: string[] = [];
  const legacyState = {
    ...state,
    filters: { ...state.filters, eventType: undefined },
    available: {
      ...state.available,
      eventTypes: ["workflow_started", "task_started"],
    },
  } as WorkflowTuiState;
  const legacyCallbacks = {
    onSelectReconcileAction: () => legacyCalls.push("select-reconciliation"),
    onRunReconcileAction: () => legacyCalls.push("run-reconciliation"),
  };
  const { renderer, renderOnce, mockInput } = await testRender(
    <ThemeProvider>
      <WorkflowRunsPanel
        state={legacyState}
        onRefresh={() => {}}
        onSelectRun={() => {}}
        onSetFilter={(filter) => filters.push(filter)}
        onClearFilters={() => {}}
        onCancelRun={() => {}}
        {...legacyCallbacks}
      />
    </ThemeProvider>,
    { width: 90, height: 36 },
  );

  await renderOnce();
  mockInput.pressKey("e");
  mockInput.pressKey("f");
  mockInput.pressKey("1");
  mockInput.pressKey("t");
  mockInput.pressKey("s");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await renderOnce();

  expect(filters).toEqual([{ taskId: "summarize" }, { status: "running" }]);
  expect(legacyCalls).toEqual([]);

  renderer.destroy();
});

test("WorkflowRunsPanel handles empty state", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <WorkflowRunsPanel
        state={{ runs: [], tasks: [], timeline: [], filters: {}, available: { taskIds: [], statuses: [] } }}
        onRefresh={() => {}}
        onSelectRun={() => {}}
        onSetFilter={() => {}}
        onClearFilters={() => {}}
        onCancelRun={() => {}}
      />
    </ThemeProvider>,
    { width: 80, height: 12 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("No persisted workflow runs");

  renderer.destroy();
});
