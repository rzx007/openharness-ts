import { describe, it, expect } from "vitest";
import type { TaskInfo } from "@openharness/services";
import {
  taskStatusToSwarmStatus,
  taskInfoToTeammateSnapshot,
  isTeammateTask,
  applyTaskEventToSnapshotMap,
  snapshotMapToList,
  type SwarmTeammateSnapshot,
} from "./swarm-status";

function makeTask(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: "task_1",
    type: "agent",
    status: "running",
    description: "Explore@default",
    cwd: "/repo",
    createdAt: 1_000,
    startedAt: 1_000,
    metadata: {},
    ...over,
  };
}

describe("taskStatusToSwarmStatus", () => {
  it("maps running → running", () => {
    expect(taskStatusToSwarmStatus(makeTask({ status: "running" }))).toBe("running");
  });

  it("maps pending → running (about to run)", () => {
    expect(taskStatusToSwarmStatus(makeTask({ status: "pending" }))).toBe("running");
  });

  it("maps completed with exitCode 0 → done", () => {
    expect(
      taskStatusToSwarmStatus(makeTask({ status: "completed", exitCode: 0 })),
    ).toBe("done");
  });

  it("maps completed with missing exitCode → done (completed implies clean exit)", () => {
    expect(taskStatusToSwarmStatus(makeTask({ status: "completed" }))).toBe("done");
  });

  it("maps completed with non-zero exitCode → error", () => {
    expect(
      taskStatusToSwarmStatus(makeTask({ status: "completed", exitCode: 2 })),
    ).toBe("error");
  });

  it("maps failed → error", () => {
    expect(taskStatusToSwarmStatus(makeTask({ status: "failed", exitCode: 1 }))).toBe("error");
  });

  it("maps stopped → error", () => {
    expect(taskStatusToSwarmStatus(makeTask({ status: "stopped" }))).toBe("error");
  });
});

describe("taskInfoToTeammateSnapshot", () => {
  it("uses taskId as the (unique) name and description as the task label", () => {
    const snap = taskInfoToTeammateSnapshot(
      makeTask({ id: "task_9", description: "Reviewer@default" }),
      5_000,
    );
    expect(snap.name).toBe("task_9");
    expect(snap.task).toBe("Reviewer@default");
  });

  it("computes duration in whole seconds from startedAt to now while running", () => {
    const snap = taskInfoToTeammateSnapshot(
      makeTask({ startedAt: 1_000, status: "running" }),
      6_500, // 5.5s elapsed → floor → 5
    );
    expect(snap.status).toBe("running");
    expect(snap.duration).toBe(5);
  });

  it("computes duration from startedAt to finishedAt once finished", () => {
    const snap = taskInfoToTeammateSnapshot(
      makeTask({
        status: "completed",
        exitCode: 0,
        startedAt: 1_000,
        finishedAt: 4_000,
      }),
      999_999, // now is ignored because finishedAt is set
    );
    expect(snap.status).toBe("done");
    expect(snap.duration).toBe(3);
  });

  it("omits duration when startedAt is absent", () => {
    const snap = taskInfoToTeammateSnapshot(
      makeTask({ startedAt: undefined }),
      9_000,
    );
    expect(snap.duration).toBeUndefined();
  });

  it("clamps negative duration to 0 (clock skew safety)", () => {
    const snap = taskInfoToTeammateSnapshot(makeTask({ startedAt: 5_000 }), 1_000);
    expect(snap.duration).toBe(0);
  });
});

describe("isTeammateTask", () => {
  it("accepts agent-type tasks", () => {
    expect(isTeammateTask(makeTask({ type: "agent" }))).toBe(true);
  });

  it("rejects shell-type tasks", () => {
    expect(isTeammateTask(makeTask({ type: "shell" }))).toBe(false);
  });
});

describe("applyTaskEventToSnapshotMap", () => {
  it("created → running snapshot added to the map", () => {
    const map = new Map<string, SwarmTeammateSnapshot>();
    const changed = applyTaskEventToSnapshotMap(
      map,
      makeTask({ id: "task_1", status: "running", startedAt: 1_000 }),
      "created",
      3_000,
    );
    expect(changed).toBe(true);
    expect(map.get("task_1")).toEqual({
      name: "task_1",
      status: "running",
      task: "Explore@default",
      duration: 2,
    });
  });

  it("completed (exit 0) overwrites the same entry as done", () => {
    const map = new Map<string, SwarmTeammateSnapshot>();
    applyTaskEventToSnapshotMap(
      map,
      makeTask({ id: "task_1", status: "running" }),
      "created",
      2_000,
    );
    const changed = applyTaskEventToSnapshotMap(
      map,
      makeTask({
        id: "task_1",
        status: "completed",
        exitCode: 0,
        startedAt: 1_000,
        finishedAt: 5_000,
      }),
      "completed",
      9_999,
    );
    expect(changed).toBe(true);
    expect(map.size).toBe(1);
    expect(map.get("task_1")).toEqual({
      name: "task_1",
      status: "done",
      task: "Explore@default",
      duration: 4,
    });
  });

  it("completed with non-zero exit → error", () => {
    const map = new Map<string, SwarmTeammateSnapshot>();
    const changed = applyTaskEventToSnapshotMap(
      map,
      makeTask({ id: "task_2", status: "failed", exitCode: 1, finishedAt: 2_000 }),
      "completed",
      9_000,
    );
    expect(changed).toBe(true);
    expect(map.get("task_2")?.status).toBe("error");
  });

  it("ignores non-agent (shell) tasks and reports no change", () => {
    const map = new Map<string, SwarmTeammateSnapshot>();
    const changed = applyTaskEventToSnapshotMap(
      map,
      makeTask({ id: "task_3", type: "shell" }),
      "created",
      1_000,
    );
    expect(changed).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("snapshotMapToList", () => {
  it("flattens the map into the teammate list", () => {
    const map = new Map<string, SwarmTeammateSnapshot>();
    applyTaskEventToSnapshotMap(map, makeTask({ id: "task_1" }), "created", 1_000);
    applyTaskEventToSnapshotMap(
      map,
      makeTask({ id: "task_2", description: "Reviewer@default" }),
      "created",
      1_000,
    );
    const list = snapshotMapToList(map);
    expect(list.map((t) => t.name)).toEqual(["task_1", "task_2"]);
    expect(list).toHaveLength(2);
  });
});
