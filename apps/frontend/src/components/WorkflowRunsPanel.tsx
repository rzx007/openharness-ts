import React, { useEffect } from "react";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useListNavigation } from "../hooks/useListNavigation";
import { useTheme } from "../theme/ThemeContext";
import type { WorkflowRunSummarySnapshot, WorkflowTuiState } from "../types";

export type WorkflowRunsPanelProps = {
  state: WorkflowTuiState | null;
  onRefresh: () => void;
  onSelectRun: (runId: string) => void;
  onSetFilter: (filter: { taskId?: string; eventType?: string; status?: string }) => void;
  onClearFilters: () => void;
  onCancelRun: (runId: string) => void;
  onSelectReconcileAction: (runId: string, actionId: string) => void;
  onRunReconcileAction: (runId: string, actionId?: string) => void;
};

const VISIBLE_RUNS = 5;
const VISIBLE_TASKS = 5;
const VISIBLE_EVENTS = 6;

export function WorkflowRunsPanel({
  state,
  onRefresh,
  onSelectRun,
  onSetFilter,
  onClearFilters,
  onCancelRun,
  onSelectReconcileAction,
  onRunReconcileAction,
}: WorkflowRunsPanelProps) {
  const { theme } = useTheme();
  const c = theme.colors;
  const runs = state?.runs ?? [];
  const selectedRunId = state?.selectedRunId;
  const selectedIndexFromState = Math.max(0, runs.findIndex((run) => run.runId === selectedRunId));
  const { index, setIndex, moveUp, moveDown } = useListNavigation(runs.length);
  const selectedRun = runs[index] ?? runs[selectedIndexFromState] ?? runs[0];

  useEffect(() => {
    setIndex(selectedIndexFromState);
  }, [selectedIndexFromState, runs.length, setIndex]);

  useKeyboard((key) => {
    if (key.name === "up") { moveUp(); return; }
    if (key.name === "down") { moveDown(); return; }
    if (key.name === "return" && selectedRun) { onSelectRun(selectedRun.runId); return; }
    if (key.name === "r") { onRefresh(); return; }
    if (key.name === "x") { onClearFilters(); return; }
    if (key.name === "c" && state?.snapshot && selectedRun?.status === "running") {
      onCancelRun(selectedRun.runId);
      return;
    }
    if (key.name === "f" && state?.reconciliation?.needed && selectedRun) {
      onRunReconcileAction(selectedRun.runId, state.selectedReconciliationActionId);
      return;
    }
    if (key.name === "t" && state) {
      onSetFilter({ taskId: nextValue(state.available.taskIds, state.filters.taskId) });
      return;
    }
    if (key.name === "e" && state) {
      onSetFilter({ eventType: nextValue(state.available.eventTypes, state.filters.eventType) });
      return;
    }
    if (key.name === "s" && state) {
      onSetFilter({ status: nextValue(state.available.statuses, state.filters.status) });
      return;
    }
    const digit = key.name ? parseInt(key.name, 10) : NaN;
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9 && state?.reconciliation?.actions.length && selectedRun) {
      const action = state.reconciliation.actions[digit - 1];
      if (action) onSelectReconcileAction(selectedRun.runId, action.actionId);
    }
  });

  const windowStart = Math.max(0, Math.min(index - 2, runs.length - VISIBLE_RUNS));
  const visibleRuns = runs.slice(windowStart, windowStart + VISIBLE_RUNS);
  const selected = state?.snapshot ? runs.find((run) => run.runId === state.selectedRunId) ?? selectedRun : selectedRun;

  return (
    <box flexDirection="column">
      <text attributes={TextAttributes.BOLD} fg={c.accent}>Workflow Runs</text>
      <text fg={c.muted}>r refresh  enter detail  t/e/s filter  x clear  c cancel  f follow-up</text>
      {state?.notice ? <text fg={c.success}>{state.notice}</text> : null}
      {state?.error ? <text fg={c.error}>{state.error}</text> : null}

      {runs.length === 0 ? (
        <text fg={c.muted}>No persisted workflow runs</text>
      ) : (
        <box flexDirection="column">
          {visibleRuns.map((run, visibleIdx) => {
            const absoluteIdx = windowStart + visibleIdx;
            const isCursor = absoluteIdx === index;
            const isSelected = run.runId === state?.selectedRunId;
            return (
              <box key={run.runId} flexDirection="column" backgroundColor={isCursor ? c.accent : undefined}>
                <text fg={isCursor ? c.background : c.foreground}>
                  {(isSelected ? "*" : " ") + " " + truncate(run.runId, 18) + " " + run.status}
                </text>
                <text fg={isCursor ? c.background : c.muted}>
                  {"  " + run.mode + " " + formatRunCounts(run) + (run.needsReconciliation ? " reconcile" : "")}
                </text>
              </box>
            );
          })}
        </box>
      )}

      {selected ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <text attributes={TextAttributes.BOLD} fg={c.muted}>DETAIL</text>
          <text fg={statusColor(selected.status, c)}>
            {" " + selected.status + " " + truncate(selected.summary, 46)}
          </text>
          <text fg={c.muted}>{" " + formatRunCounts(selected)}</text>
          {formatFilters(state) ? <text fg={c.warning}>{" " + formatFilters(state)}</text> : null}
          {state?.tasks.slice(0, VISIBLE_TASKS).map((task) => (
            <box key={task.taskId} flexDirection="column">
              <text fg={statusColor(task.status, c)}>
                {"  " + truncate(task.taskId, 18) + " " + task.status}
              </text>
              {task.summary ? <text fg={c.muted}>{"   " + truncate(task.summary, 48)}</text> : null}
            </box>
          ))}
          {state && state.tasks.length > VISIBLE_TASKS ? <text fg={c.muted}>{`  +${state.tasks.length - VISIBLE_TASKS} tasks`}</text> : null}
        </box>
      ) : null}

      {state?.timeline.length ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <text attributes={TextAttributes.BOLD} fg={c.muted}>TIMELINE</text>
          {state.timeline.slice(-VISIBLE_EVENTS).map((event, i) => (
            <text key={`${event.timestamp}-${event.type}-${i}`} fg={c.muted}>
              {" " + event.type + formatEventMeta(event) + ": " + truncate(event.summary, 38)}
            </text>
          ))}
        </box>
      ) : null}

      {state?.reconciliation?.needed ? (
        <box flexDirection="column">
          <text>{" "}</text>
          <text attributes={TextAttributes.BOLD} fg={c.warning}>RECONCILE</text>
          <text fg={c.warning}>{" " + truncate(state.reconciliation.summary, 52)}</text>
          <text fg={c.muted}>{" 1-9 select action; f run follow-up"}</text>
          {state.reconciliation.actions.slice(0, 3).map((action, i) => (
            <text key={action.actionId} fg={action.actionId === state.selectedReconciliationActionId ? c.success : c.muted}>
              {`${action.actionId === state.selectedReconciliationActionId ? ">" : " "} ${i + 1}. ${truncate(action.actionId, 18)} ${truncate(action.description, 28)}`}
            </text>
          ))}
          {state.reconciliationSpec ? <text fg={c.success}> follow-up spec selected; press f to run</text> : null}
        </box>
      ) : null}
    </box>
  );
}

function nextValue(values: string[], current?: string): string | undefined {
  if (values.length === 0) return undefined;
  if (!current) return values[0];
  const idx = values.indexOf(current);
  const next = values[(idx + 1) % (values.length + 1)];
  return next;
}

function formatRunCounts(run: WorkflowRunSummarySnapshot): string {
  const parts = [
    `${run.completedTasks}/${run.totalTasks}`,
    run.runningTasks ? `${run.runningTasks} running` : undefined,
    run.blockedTasks ? `${run.blockedTasks} blocked` : undefined,
    run.pendingTasks ? `${run.pendingTasks} pending` : undefined,
    run.failedTasks ? `${run.failedTasks} failed` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}

function formatFilters(state: WorkflowTuiState | null): string | undefined {
  const filters = state?.filters;
  if (!filters) return undefined;
  const parts = [
    filters.taskId ? `task=${filters.taskId}` : undefined,
    filters.eventType ? `event=${filters.eventType}` : undefined,
    filters.status ? `status=${filters.status}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(" ") : undefined;
}

function formatEventMeta(event: { taskId?: string; status?: string }): string {
  const parts = [event.taskId, event.status ? `[${event.status}]` : undefined]
    .filter((part): part is string => part !== undefined);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function statusColor(
  status: string,
  colors: { success: string; warning: string; error: string; muted: string; foreground: string },
): string {
  if (status === "completed" || status === "done") return colors.success;
  if (status === "running") return colors.success;
  if (status === "failed" || status === "error") return colors.error;
  if (status === "blocked" || status === "pending" || status === "skipped") return colors.warning;
  return colors.muted;
}
