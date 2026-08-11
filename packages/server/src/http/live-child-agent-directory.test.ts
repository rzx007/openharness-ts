import { describe, expect, it, vi } from "vitest";

import { LiveChildAgentDirectory } from "./live-child-agent-directory.js";

describe("LiveChildAgentDirectory", () => {
  it("routes through the framework-owned child directory without copying controls", async () => {
    const send = vi.fn(async () => ({ sessionId: "child-session", inputId: "input-1", runId: "run-1" }));
    const interrupt = vi.fn(async () => {});
    const child = { send, interrupt };
    const rootAgent = {
      children: { get: vi.fn(() => child) },
    } as any;
    const directory = new LiveChildAgentDirectory();
    directory.register("child-session", "child-1", rootAgent);

    await expect(directory.send("child-session", { content: "follow up" })).resolves.toMatchObject({ inputId: "input-1" });
    await expect(directory.interrupt("child-session", "stop")).resolves.toBe(true);
    expect(rootAgent.children.get).toHaveBeenCalledWith("child-1");
    expect(send).toHaveBeenCalledWith({ content: "follow up" });
    expect(interrupt).toHaveBeenCalledWith("stop");

    directory.unregister("child-session", "child-1");
    expect(directory.has("child-session")).toBe(false);
  });
});
