import { describe, expect, it } from "vitest";

import { DaemonOperationGate, DaemonOperationUnavailableError } from "./daemon-operation-gate.js";

describe("DaemonOperationGate", () => {
  it("linearizes shared runtime access with scoped and global barriers", () => {
    const gate = new DaemonOperationGate();
    const shared = gate.enter({ sessionId: "s1", cwd: "/repo" });

    expect(gate.tryEnterBarrier({ kind: "session", sessionId: "s1", cwd: "/repo" }, () => true))
      .toBeUndefined();
    const other = gate.tryEnterBarrier({ kind: "cwd", cwd: "/other" }, () => true)!;
    expect(other).toBeDefined();
    other.release();
    shared.release();

    const barrier = gate.tryEnterBarrier({ kind: "cwd", cwd: "/repo" }, () => true)!;
    expect(() => gate.enter({ sessionId: "s2", cwd: "/repo" }))
      .toThrow(DaemonOperationUnavailableError);
    expect(() => gate.enter({ sessionId: "s3", cwd: "/other" })).not.toThrow();
    barrier.release();
  });

  it("closes admission immediately and waits for existing leases to drain", async () => {
    const gate = new DaemonOperationGate();
    const lease = gate.enter({ sessionId: "s1", cwd: "/repo" });
    let drained = false;
    const shutdown = gate.beginShutdown().then(() => { drained = true; });

    expect(gate.accepting).toBe(false);
    expect(() => gate.enter({ sessionId: "s2", cwd: "/repo" }))
      .toThrowError(/closing/);
    await Promise.resolve();
    expect(drained).toBe(false);

    lease.release();
    await shutdown;
    expect(drained).toBe(true);
    gate.markClosed();
  });
});
