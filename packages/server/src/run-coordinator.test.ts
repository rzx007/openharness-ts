import { describe, expect, it } from "vitest";

import { RunInterruptedError, SessionRunCoordinator } from "./run-coordinator.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionRunCoordinator", () => {
  it("serializes runs for the same session", async () => {
    const coordinator = new SessionRunCoordinator();
    const firstRelease = deferred();
    const order: string[] = [];

    const first = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      work: async () => {
        order.push("r1:start");
        await firstRelease.promise;
        order.push("r1:end");
      },
    });
    const second = coordinator.enqueue({
      sessionId: "s1",
      runId: "r2",
      work: async () => {
        order.push("r2:start");
      },
    });

    expect(first.state).toBe("running");
    expect(second.state).toBe("queued");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["r1:start"]);

    firstRelease.resolve();
    await Promise.all([first.promise, second.promise]);
    expect(order).toEqual(["r1:start", "r1:end", "r2:start"]);
  });

  it("allows different sessions to run concurrently", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    const order: string[] = [];

    const a = coordinator.enqueue({
      sessionId: "s1",
      runId: "a",
      work: async () => {
        order.push("a:start");
        await release.promise;
      },
    });
    const b = coordinator.enqueue({
      sessionId: "s2",
      runId: "b",
      work: async () => {
        order.push("b:start");
        await release.promise;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(order.sort()).toEqual(["a:start", "b:start"]);
    release.resolve();
    await Promise.all([a.promise, b.promise]);
  });

  it("merges wake signals into the active session run", async () => {
    const coordinator = new SessionRunCoordinator();
    const release = deferred();
    let observedWakeCount = 0;

    const run = coordinator.enqueue({
      sessionId: "s1",
      runId: "r1",
      work: async (context) => {
        await release.promise;
        observedWakeCount = context.wakeCount();
      },
    });

    expect(coordinator.mergeWake("s1")).toMatchObject({ merged: true, wakeCount: 1, activeRunId: "r1" });
    expect(coordinator.mergeWake("s1")).toMatchObject({ merged: true, wakeCount: 2, activeRunId: "r1" });
    expect(coordinator.mergeWake("missing")).toEqual({ merged: false, wakeCount: 0 });
    release.resolve();
    await run.promise;
    expect(observedWakeCount).toBe(2);
  });

  it("interrupts the active run and rejects queued runs", async () => {
    const coordinator = new SessionRunCoordinator();
    const activeInterrupted = deferred();

    const active = coordinator.enqueue({
      sessionId: "s1",
      runId: "active",
      work: async (context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            activeInterrupted.resolve();
            resolve();
          }, { once: true });
        });
        throw new RunInterruptedError();
      },
    });
    const queued = coordinator.enqueue({
      sessionId: "s1",
      runId: "queued",
      work: async () => {
        throw new Error("should not run");
      },
    });

    const result = coordinator.interrupt("s1");
    expect(result).toEqual({
      activeRunId: "active",
      queuedRunIds: ["queued"],
      interrupted: true,
    });
    await activeInterrupted.promise;
    await expect(active.promise).rejects.toBeInstanceOf(RunInterruptedError);
    await expect(queued.promise).rejects.toBeInstanceOf(RunInterruptedError);
  });
});

