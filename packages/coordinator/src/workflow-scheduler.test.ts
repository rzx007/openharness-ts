import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowNotification,
  createWorkflowPlan,
  formatWorkflowNotification,
  parseWorkflowNotification,
  runWorkflow,
} from "./workflow-scheduler.js";

describe("createWorkflowPlan", () => {
  it("plans an explicit DAG in topological order", () => {
    const plan = createWorkflowPlan({
      mode: "parallel",
      tasks: [
        { id: "implement", dependsOn: ["research"] },
        { id: "research" },
        { id: "verify", dependsOn: ["implement"] },
      ],
    });

    expect(plan.executionOrder).toEqual(["research", "implement", "verify"]);
    expect(plan.dependencyMap).toEqual({
      implement: ["research"],
      research: [],
      verify: ["implement"],
    });
  });

  it("turns sequential tasks into a one-at-a-time chain", () => {
    const plan = createWorkflowPlan({
      mode: "sequential",
      tasks: [{ id: "clean" }, { id: "build" }, { id: "test" }],
      maxConcurrency: 10,
    });

    expect(plan.maxConcurrency).toBe(1);
    expect(plan.dependencyMap).toEqual({
      clean: [],
      build: ["clean"],
      test: ["build"],
    });
  });

  it("rejects duplicate ids, missing dependencies, and cycles", () => {
    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [{ id: "a" }, { id: "a" }],
      }),
    ).toThrow("Duplicate workflow task id 'a'");

    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [{ id: "a", dependsOn: ["missing"] }],
      }),
    ).toThrow("depends on missing task 'missing'");

    expect(() =>
      createWorkflowPlan({
        mode: "parallel",
        tasks: [
          { id: "a", dependsOn: ["b"] },
          { id: "b", dependsOn: ["a"] },
        ],
      }),
    ).toThrow("dependency cycle");
  });
});

describe("runWorkflow", () => {
  it("runs independent tasks in parallel up to maxConcurrency", async () => {
    const started: string[] = [];
    const unblock: Array<() => void> = [];
    let running = 0;
    let maxRunning = 0;

    const workflow = runWorkflow(
      {
        mode: "parallel",
        maxConcurrency: 2,
        tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
      },
      async ({ task }) => {
        started.push(task.id);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => unblock.push(resolve));
        running -= 1;
        return { summary: `${task.id} done`, result: task.id };
      },
    );

    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    expect(maxRunning).toBe(2);

    unblock.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    unblock.shift()?.();
    unblock.shift()?.();

    const result = await workflow;
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("3/3 tasks completed");
  });

  it("passes pipeline input from the previous task", async () => {
    const seenPipelineInputs: Array<string | undefined> = [];
    const result = await runWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "implement" }, { id: "verify" }],
      },
      ({ task, pipelineInput }) => {
        seenPipelineInputs.push(pipelineInput?.taskId);
        return { summary: `${task.id} done`, result: `${task.id}-result` };
      },
    );

    expect(result.status).toBe("completed");
    expect(seenPipelineInputs).toEqual([undefined, "research", "implement"]);
    expect(result.results.verify?.result).toBe("verify-result");
  });

  it("skips dependents after a failed dependency by default", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [
          { id: "research" },
          { id: "implement", dependsOn: ["research"] },
          { id: "verify", dependsOn: ["implement"] },
          { id: "docs" },
        ],
      },
      ({ task }) => {
        if (task.id === "implement") {
          return { status: "failed", summary: "patch failed" };
        }
        return { summary: `${task.id} done` };
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.research?.status).toBe("completed");
    expect(result.results.implement?.status).toBe("failed");
    expect(result.results.verify?.status).toBe("skipped");
    expect(result.results.docs?.status).toBe("completed");
  });

  it("supports fail-fast by skipping unstarted work after the first failure", async () => {
    const result = await runWorkflow(
      {
        mode: "sequential",
        failurePolicy: "fail-fast",
        tasks: [{ id: "a" }, { id: "b" }, { id: "c" }],
      },
      ({ task }) =>
        task.id === "a"
          ? { status: "failed", summary: "boom" }
          : { summary: `${task.id} done` },
    );

    expect(result.results.a?.status).toBe("failed");
    expect(result.results.b?.status).toBe("skipped");
    expect(result.results.c?.status).toBe("skipped");
  });

  it("supports continue by running dependents after failed dependencies", async () => {
    const result = await runWorkflow(
      {
        mode: "parallel",
        failurePolicy: "continue",
        tasks: [
          { id: "research" },
          { id: "implement", dependsOn: ["research"] },
        ],
      },
      ({ task, dependencyResults }) => {
        if (task.id === "research") {
          return { status: "failed", summary: "inconclusive" };
        }
        expect(dependencyResults.research?.status).toBe("failed");
        return { summary: "implemented fallback" };
      },
    );

    expect(result.status).toBe("failed");
    expect(result.results.research?.status).toBe("failed");
    expect(result.results.implement?.status).toBe("completed");
  });

  it("retries failed tasks before marking them failed", async () => {
    const attempts: number[] = [];
    const result = await runWorkflow(
      {
        mode: "parallel",
        tasks: [{ id: "flaky", retry: { maxAttempts: 3 } }],
      },
      ({ attempt }) => {
        attempts.push(attempt);
        if (attempt < 3) throw new Error("temporary");
        return { summary: "recovered" };
      },
    );

    expect(attempts).toEqual([1, 2, 3]);
    expect(result.results.flaky?.status).toBe("completed");
    expect(result.results.flaky?.attempts).toBe(3);
  });
});

describe("workflow notification envelope", () => {
  it("formats and parses structured workflow results", async () => {
    const result = await runWorkflow(
      {
        mode: "pipeline",
        tasks: [{ id: "research" }, { id: "verify" }],
      },
      ({ task }) => ({
        summary: `${task.id} <done>`,
        result: `result for ${task.id}\nwith </workflow-notification> text`,
        metadata: { task: task.id },
      }),
    );

    const notification = createWorkflowNotification(result);
    expect(notification).toMatchObject({
      status: "completed",
      summary: "2/2 tasks completed",
      mode: "pipeline",
      totalTasks: 2,
      completedTasks: 2,
      failedTasks: 0,
    });

    const text = formatWorkflowNotification(result);
    expect(text).toContain("<workflow-notification>");
    expect(text).toContain("<payload>");
    expect(text).not.toContain("result for research\nwith </workflow-notification> text");

    const parsed = parseWorkflowNotification(text);
    expect(parsed).toEqual(notification);
    expect(parsed?.tasks[0]?.result).toContain("</workflow-notification>");
  });

  it("returns undefined for malformed workflow notifications", () => {
    expect(parseWorkflowNotification("nope")).toBeUndefined();
    expect(parseWorkflowNotification("<workflow-notification><payload>{}</payload></workflow-notification>")).toBeUndefined();
  });
});
