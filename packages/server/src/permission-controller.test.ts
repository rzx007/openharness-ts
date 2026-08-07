import { describe, expect, it, vi } from "vitest";

import { PermissionController } from "./permission-controller.js";

describe("PermissionController", () => {
  it("resolves a pending wait with the permission decision", async () => {
    const controller = new PermissionController();
    const expire = vi.fn();
    const result = controller.wait({ requestId: "p1", expire });

    expect(controller.pendingCount("p1")).toBe(1);
    expect(controller.resolve("p1", { status: "approved", decision: "once" })).toBe(true);

    await expect(result).resolves.toEqual({ status: "approved", decision: "once" });
    expect(expire).not.toHaveBeenCalled();
    expect(controller.pendingCount()).toBe(0);
  });

  it("expires and resolves when the run aborts while waiting", async () => {
    const controller = new PermissionController();
    const abort = new AbortController();
    const expire = vi.fn();
    const result = controller.wait({ requestId: "p1", signal: abort.signal, expire });

    abort.abort();

    await expect(result).resolves.toEqual({
      status: "expired",
      reason: "Run interrupted while waiting for permission",
    });
    expect(expire).toHaveBeenCalledWith("Run interrupted while waiting for permission");
    expect(controller.pendingCount()).toBe(0);
  });

  it("expires immediately when the signal is already aborted", async () => {
    const controller = new PermissionController();
    const abort = new AbortController();
    const expire = vi.fn();
    abort.abort();

    await expect(controller.wait({ requestId: "p1", signal: abort.signal, expire })).resolves.toEqual({
      status: "expired",
      reason: "Run interrupted before permission reply",
    });
    expect(expire).toHaveBeenCalledWith("Run interrupted before permission reply");
    expect(controller.pendingCount()).toBe(0);
  });

  it("ignores resolves for unknown requests", () => {
    const controller = new PermissionController();

    expect(controller.resolve("missing", { status: "denied" })).toBe(false);
  });
});
