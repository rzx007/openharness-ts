import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentChildAgentHost,
  AgentRunHost,
  AgentRunScope,
  Settings,
} from "@openharness/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composeAgentRunHost, createOpenHarnessAgent } from "./agent.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createOpenHarnessAgent", () => {
  it("preserves prototype host capabilities when attaching child controls", async () => {
    const scope = {
      sessionId: "session-1",
      inputId: "input-1",
      runId: "run-1",
      cwd: "/repo",
      traceId: "trace-1",
      signal: new AbortController().signal,
    } satisfies AgentRunScope;
    const emitEvent = vi.fn();
    const emitStreamEvent = vi.fn();
    const requestPermission = vi.fn(async () => ({ status: "approved" as const }));

    class PrototypeHost implements AgentRunHost {
      constructor(readonly scope: AgentRunScope) {}
      emitEvent(event: Parameters<AgentRunHost["emitEvent"]>[0]) {
        return emitEvent(event);
      }
      emitStreamEvent(event: Parameters<AgentRunHost["emitStreamEvent"]>[0]) {
        return emitStreamEvent(event);
      }
      requestPermission(request: Parameters<AgentRunHost["requestPermission"]>[0]) {
        return requestPermission(request);
      }
    }

    const childAgentHost = {} as AgentChildAgentHost;
    const host = composeAgentRunHost(new PrototypeHost(scope), childAgentHost);
    await host.emitEvent({ type: "runtime.ready" });
    await host.emitStreamEvent({ type: "text_delta", delta: "hello" });
    await host.requestPermission({ toolName: "Bash" });

    expect(host.scope).toBe(scope);
    expect(host.childAgentHost).toBe(childAgentHost);
    expect(emitEvent).toHaveBeenCalledWith({ type: "runtime.ready" });
    expect(emitStreamEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "hello" });
    expect(requestPermission).toHaveBeenCalledWith({ toolName: "Bash" });
  });

  it("constructs a standalone agent without daemon services", async () => {
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
    expect(agent.getHistory()).toEqual([]);
    expect(agent.inspect().tools.length).toBeGreaterThan(0);
    expect(agent.inspect().model).toBe("claude-test");
    expect(agent.getUsage()).toEqual(expect.objectContaining({ inputTokens: 0, outputTokens: 0 }));
    await agent.close();
  });
});
