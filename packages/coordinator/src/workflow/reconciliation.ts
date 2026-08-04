import { normalizeWriteScope, runnableWriteScopes, writeScopesOverlap } from "./validation.js";
import type {
  WorkflowDiffFileSummary,
  WorkflowPlan,
  WorkflowReconciliationIssue,
  WorkflowReconciliationPlan,
  WorkflowReconciliationSpecOptions,
  WorkflowReconciliationSummary,
  WorkflowSpec,
  WorkflowTask,
  WorkflowTaskRunResult,
} from "./model.js";

export function collectWorkflowReconciliationIssues(
  plan: WorkflowPlan,
  orderedResults: WorkflowTaskRunResult[],
): WorkflowReconciliationIssue[] {
  const resultByTaskId = new Map(orderedResults.map((result) => [result.taskId, result]));
  const completedTaskIds = new Set(
    orderedResults
      .filter((result) => result.status === "completed")
      .map((result) => result.taskId),
  );
  const issues: WorkflowReconciliationIssue[] = [];
  const actualConflictPairs = new Set<string>();
  const tasks = plan.executionOrder
    .map((taskId) => requireWorkflowTask(plan.tasks, taskId))
    .filter((task) => completedTaskIds.has(task.id));

  for (let i = 0; i < tasks.length; i += 1) {
    const left = tasks[i]!;
    const leftChangedFiles = changedFilesFromResult(resultByTaskId.get(left.id));
    const leftScopes = runnableWriteScopes(left);
    for (const right of tasks.slice(i + 1)) {
      const pairId = `${left.id}-${right.id}`;
      const rightChangedFiles = changedFilesFromResult(resultByTaskId.get(right.id));
      const changedFiles = leftChangedFiles.filter((leftFile) => rightChangedFiles.includes(leftFile));
      if (changedFiles.length > 0) {
        actualConflictPairs.add(pairId);
        issues.push({
          issueId: `reconcile-actual-${pairId}`,
          type: "changed-file-overlap",
          severity: "actual-conflict",
          taskIds: [left.id, right.id],
          writeScope: [...new Set([...runnableWriteScopes(left), ...runnableWriteScopes(right)])].sort(),
          changedFiles: [...new Set(changedFiles)].sort(),
          summary: `Tasks '${left.id}' and '${right.id}' both changed: ${[...new Set(changedFiles)].sort().join(", ")}`,
        });
        continue;
      }

      if (actualConflictPairs.has(pairId) || leftScopes.length === 0) continue;
      const rightScopes = runnableWriteScopes(right);
      const overlap = leftScopes.filter((leftScope) =>
        rightScopes.some((rightScope) => writeScopesOverlap(leftScope, rightScope)),
      );
      if (overlap.length === 0) continue;
      const rightOverlap = rightScopes.filter((rightScope) =>
        leftScopes.some((leftScope) => writeScopesOverlap(leftScope, rightScope)),
      );
      const writeScope = [...new Set([...overlap, ...rightOverlap])].sort();
      issues.push({
        issueId: `reconcile-${left.id}-${right.id}`,
        type: "write-scope-overlap",
        severity: "needs-reconciliation",
        taskIds: [left.id, right.id],
        writeScope,
        summary: `Tasks '${left.id}' and '${right.id}' wrote overlapping scopes: ${writeScope.join(", ")}`,
      });
    }
  }

  return issues;
}

function requireWorkflowTask(tasks: WorkflowTask[], taskId: string): WorkflowTask {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown workflow task '${taskId}'`);
  return task;
}

export function createReconciliationIssueIdsByTask(
  issues: WorkflowReconciliationIssue[],
): Record<string, string[]> {
  const byTask: Record<string, string[]> = {};
  for (const issue of issues) {
    for (const taskId of issue.taskIds) {
      byTask[taskId] = [...(byTask[taskId] ?? []), issue.issueId];
    }
  }
  return byTask;
}

export function createWorkflowReconciliationSummary(
  issues: WorkflowReconciliationIssue[],
  orderedResults: WorkflowTaskRunResult[],
): WorkflowReconciliationSummary {
  const resultByTaskId = new Map(orderedResults.map((result) => [result.taskId, result]));
  const fileSummaries = new Map<string, {
    issueIds: Set<string>;
    taskIds: Set<string>;
    statuses: Record<string, WorkflowDiffFileSummary["status"]>;
    insertionsByTask: Map<string, number>;
    deletionsByTask: Map<string, number>;
  }>();
  const taskSummaries = new Map<string, {
    issueIds: Set<string>;
    changedFiles: Set<string>;
    insertionsByFile: Map<string, number>;
    deletionsByFile: Map<string, number>;
  }>();

  for (const issue of issues) {
    const issueFiles = issue.changedFiles?.map(normalizeWriteScope).filter((file) => file.length > 0);
    for (const taskId of issue.taskIds) {
      const taskSummary = taskSummaries.get(taskId) ?? {
        issueIds: new Set<string>(),
        changedFiles: new Set<string>(),
        insertionsByFile: new Map<string, number>(),
        deletionsByFile: new Map<string, number>(),
      };
      taskSummary.issueIds.add(issue.issueId);
      taskSummaries.set(taskId, taskSummary);

      const diffFiles = diffFilesFromResult(resultByTaskId.get(taskId));
      const filesForTask = issueFiles?.length
        ? diffFiles.filter((file) => issueFiles.includes(file.path))
        : diffFiles.filter((file) => issue.writeScope.some((scope) => writeScopesOverlap(file.path, normalizeWriteScope(scope))));
      for (const file of filesForTask) {
        taskSummary.changedFiles.add(file.path);
        taskSummary.insertionsByFile.set(file.path, file.insertions ?? 0);
        taskSummary.deletionsByFile.set(file.path, file.deletions ?? 0);

        const fileSummary = fileSummaries.get(file.path) ?? {
          issueIds: new Set<string>(),
          taskIds: new Set<string>(),
          statuses: {},
          insertionsByTask: new Map<string, number>(),
          deletionsByTask: new Map<string, number>(),
        };
        fileSummary.issueIds.add(issue.issueId);
        fileSummary.taskIds.add(taskId);
        fileSummary.statuses[taskId] = file.status;
        fileSummary.insertionsByTask.set(taskId, file.insertions ?? 0);
        fileSummary.deletionsByTask.set(taskId, file.deletions ?? 0);
        fileSummaries.set(file.path, fileSummary);
      }
    }
  }

  return {
    totalIssues: issues.length,
    actualConflicts: issues.filter((issue) => issue.severity === "actual-conflict").length,
    declaredScopeOverlaps: issues.filter((issue) => issue.type === "write-scope-overlap").length,
    files: [...fileSummaries.entries()]
      .map(([path, summary]) => ({
        path,
        issueIds: [...summary.issueIds].sort(),
        taskIds: [...summary.taskIds].sort(),
        statuses: Object.fromEntries(Object.entries(summary.statuses).sort(([left], [right]) => left.localeCompare(right))),
        insertions: sumMapValues(summary.insertionsByTask),
        deletions: sumMapValues(summary.deletionsByTask),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    tasks: [...taskSummaries.entries()]
      .map(([taskId, summary]) => ({
        taskId,
        issueIds: [...summary.issueIds].sort(),
        changedFiles: [...summary.changedFiles].sort(),
        insertions: sumMapValues(summary.insertionsByFile),
        deletions: sumMapValues(summary.deletionsByFile),
      }))
      .sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

export function createWorkflowReconciliationPlan(
  issues: WorkflowReconciliationIssue[],
): WorkflowReconciliationPlan {
  if (issues.length === 0) {
    return {
      needed: false,
      summary: "No reconciliation follow-up needed",
      actions: [],
    };
  }

  const actions = issues.map((issue) => {
    const taskId = `reconcile-${issue.issueId}`.replace(/[^A-Za-z0-9._-]/g, "-");
    const changedFiles = issue.changedFiles?.length ? `Changed files: ${issue.changedFiles.join(", ")}.` : "";
    const writeScope = issue.changedFiles?.length ? issue.changedFiles : issue.writeScope;
    return {
      actionId: `followup-${issue.issueId}`,
      issueIds: [issue.issueId],
      taskId,
      description: `Reconcile ${issue.type} for ${issue.taskIds.join(" and ")}`,
      prompt: [
        `Reconcile workflow issue ${issue.issueId}.`,
        issue.summary,
        `Affected tasks: ${issue.taskIds.join(", ")}.`,
        writeScope.length > 0 ? `Write scope: ${writeScope.join(", ")}.` : undefined,
        changedFiles || undefined,
        "Inspect the task outputs and current files, apply the smallest safe fix, and report any remaining conflict.",
      ].filter((line): line is string => line !== undefined && line.length > 0).join("\n"),
      writeScope: [...new Set(writeScope)].sort(),
      dependsOn: [...issue.taskIds],
    };
  });

  return {
    needed: true,
    summary: `${issues.length} reconciliation follow-up action(s) available`,
    actions,
  };
}

export function createWorkflowSpecFromReconciliationPlan(
  plan: WorkflowReconciliationPlan,
  options: WorkflowReconciliationSpecOptions = {},
): WorkflowSpec | undefined {
  const actions = plan.actions.filter((action) => {
    const matchesAction = !options.actionIds || options.actionIds.includes(action.actionId);
    const matchesIssue = !options.issueIds || action.issueIds.some((issueId) => options.issueIds?.includes(issueId));
    return matchesAction && matchesIssue;
  });
  if (actions.length === 0) return undefined;

  const reconcileTasks: WorkflowTask[] = actions.map((action) => ({
    id: action.taskId,
    description: action.description,
    prompt: action.prompt,
    writeScope: [...action.writeScope],
    isolate: true,
    metadata: {
      reconciliationActionId: action.actionId,
      reconciliationIssueIds: [...action.issueIds],
    },
  }));
  const verifyTaskId = options.verifyTaskId ?? "verify-reconciliation";
  return {
    mode: "parallel",
    maxConcurrency: 1,
    failurePolicy: "fail-fast",
    budgetPolicyPreset: options.budgetPolicyPreset ?? "safe-write",
    tasks: [
      ...reconcileTasks,
      {
        id: verifyTaskId,
        description: "Verify reconciliation changes and summarize any remaining conflicts.",
        prompt: [
          "Verify the reconciliation work from the preceding tasks.",
          `Reconciled tasks: ${reconcileTasks.map((task) => task.id).join(", ")}.`,
          "Run targeted checks where practical, inspect the touched files, and report any remaining conflict.",
        ].join("\n"),
        readOnly: true,
        dependsOn: reconcileTasks.map((task) => task.id),
      },
    ],
  };
}

export function summaryWithReconciliation(summary: string, issues: WorkflowReconciliationIssue[]): string {
  return issues.length === 0 || summary.includes("reconciliation issue")
    ? summary
    : `${summary}; ${issues.length} reconciliation issue(s)`;
}

function changedFilesFromResult(result: WorkflowTaskRunResult | undefined): string[] {
  const metadata = result?.metadata;
  if (!metadata) return [];
  const value = Array.isArray(metadata.changedFiles)
    ? metadata.changedFiles
    : isRecord(metadata.diff) && Array.isArray(metadata.diff.changedFiles)
      ? metadata.diff.changedFiles
      : isRecord(metadata.diff) && Array.isArray(metadata.diff.files)
        ? metadata.diff.files.map((file) => isRecord(file) ? file.path : undefined)
      : undefined;
  if (!value) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map(normalizeWriteScope)
    .filter((file) => file.length > 0);
}

function diffFilesFromResult(result: WorkflowTaskRunResult | undefined): WorkflowDiffFileSummary[] {
  const metadata = result?.metadata;
  if (!metadata) return [];
  if (isRecord(metadata.diff) && Array.isArray(metadata.diff.files)) {
    return metadata.diff.files
      .filter(isRecord)
      .map((file) => ({
        path: typeof file.path === "string" ? normalizeWriteScope(file.path) : "",
        status: normalizeDiffFileStatus(file.status),
        insertions: typeof file.insertions === "number" && Number.isFinite(file.insertions) ? file.insertions : undefined,
        deletions: typeof file.deletions === "number" && Number.isFinite(file.deletions) ? file.deletions : undefined,
      }))
      .filter((file) => file.path.length > 0);
  }
  return changedFilesFromResult(result).map((path) => ({
    path,
    status: "other",
  }));
}

function normalizeDiffFileStatus(status: unknown): WorkflowDiffFileSummary["status"] {
  return status === "added" ||
    status === "modified" ||
    status === "deleted" ||
    status === "renamed" ||
    status === "untracked" ||
    status === "other"
    ? status
    : "other";
}

function sumMapValues(values: Map<string, number>): number {
  return [...values.values()].reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
