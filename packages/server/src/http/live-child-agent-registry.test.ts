import { describe, expect, it, vi } from "vitest";

import { LiveChildAgentRegistry } from "./live-child-agent-registry.js";

describe("LiveChildAgentRegistry", () => {
  it("routes by durable child session without taking ownership of the controls", async () => {
    const interrupt = vi.fn(async () => {});
    const registry = new LiveChildAgentRegistry();
    registry.register("child-session", "child-invocation", {
      send: vi.fn(async () => {}),
      interrupt,
    });

    await expect(registry.interrupt("child-session", "stop requested")).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledWith("stop requested");

    registry.unregister("child-session", "another-invocation");
    await expect(registry.interrupt("child-session")).resolves.toBe(true);
    registry.unregister("child-session", "child-invocation");
    await expect(registry.interrupt("child-session")).resolves.toBe(false);
  });
});
