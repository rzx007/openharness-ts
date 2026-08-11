import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRunNotAcceptingInputError, type Settings } from "@openharness/core";
import { afterEach, describe, expect, it } from "vitest";

import { createOpenHarnessAgent } from "./agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createOpenHarnessAgent", () => {
  it("constructs a standalone programmatic agent without daemon services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };

    const agent = await createOpenHarnessAgent({ cwd, settings });

    expect(agent.id).toMatch(/^agent_session_/);
    expect(agent.events.subscribe).toBeTypeOf("function");
    expect(agent.children.list()).toEqual([]);
    expect(agent.getHistory()).toEqual([]);
    expect(agent.inspect().tools.length).toBeGreaterThan(0);
    expect(agent.inspect().model).toBe("claude-test");
    expect(agent.getUsage()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    await agent.close();
  });

  it("rejects an accepted steer when the run fails before a turn boundary", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createOpenHarnessAgent({ cwd, settings });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      throw new Error("provider failed before boundary");
    };

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const steer = run.steer({ id: "input-steer", content: "follow up" });

    await expect(run.result).rejects.toThrow("provider failed before boundary");
    await expect(steer).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });

  it("settles concurrent steers one boundary at a time", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-agent-"));
    tempDirs.push(cwd);
    const settings: Settings = {
      apiKey: "test-key",
      apiFormat: "anthropic",
      model: "claude-test",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };
    const agent = await createOpenHarnessAgent({ cwd, settings });
    (agent as any).runtime.apiClient.streamMessage = async function* () {
      yield { type: "complete", stopReason: "end_turn" };
    };
    agent.events.subscribe((event) => {
      if (event.type === "input.accepted" && event.context.inputId === "input-steer-2") {
        throw new Error("second projection failed");
      }
    });

    const run = agent.submitMessage("hello", {
      ids: { inputId: "input-root", runId: "run-root", traceId: "trace-root" },
    });
    const first = run.steer({ id: "input-steer-1", content: "first" });
    const second = run.steer({ id: "input-steer-2", content: "second" });

    await expect(first).resolves.toEqual({
      sessionId: agent.id,
      inputId: "input-steer-1",
      runId: "run-root",
    });
    await expect(run.result).rejects.toThrow("second projection failed");
    await expect(second).rejects.toBeInstanceOf(AgentRunNotAcceptingInputError);
    await agent.close();
  });
});
