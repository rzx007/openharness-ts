import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentEvent,
  Settings,
  StreamingMessageClient,
} from "@openharness/core";
import { describe, expect, it, vi } from "vitest";

import { createOpenHarnessAgent } from "./index.js";

describe("programmatic agent SDK", () => {
  it("runs a complete turn without daemon, including events and permission decisions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-sdk-"));
    const reliableEvents: AgentEvent[] = [];
    const observedEvents: AgentEvent[] = [];
    const requestPermission = vi.fn(async () => ({
      status: "denied" as const,
      reason: "SDK integration test",
    }));
    let modelTurn = 0;
    const client: StreamingMessageClient = {
      async *streamMessage() {
        modelTurn++;
        if (modelTurn === 1) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "tool-sdk-1",
              name: "Bash",
              input: { command: "echo should-not-run" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta" as const, delta: "hello from sdk" };
        yield {
          type: "usage" as const,
          usage: { inputTokens: 3, outputTokens: 4 },
        };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const settings: Settings = {
      apiFormat: "anthropic",
      model: "sdk-test-model",
      maxTurns: 3,
      permission: { mode: "default" },
      sandbox: { enabled: false },
    };

    const agent = await createOpenHarnessAgent({
      cwd,
      settings,
      client,
      requestPermission,
      onEvent: (event) => { reliableEvents.push(event); },
    });
    agent.subscribe(() => { throw new Error("observer failures are isolated"); });
    const unsubscribe = agent.subscribe((event) => { observedEvents.push(event); });

    try {
      const run = agent.submitMessage("say hello");
      await expect(run.result).resolves.toEqual(expect.objectContaining({
        status: "completed",
        output: "hello from sdk",
      }));

      expect(requestPermission).toHaveBeenCalledOnce();
      expect(modelTurn).toBe(2);
      expect(reliableEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "run.started",
          "permission.requested",
          "permission.resolved",
          "tool.completed",
          "output.text.delta",
          "run.completed",
        ]),
      );
      expect(observedEvents.map((event) => event.type)).toEqual(
        reliableEvents.map((event) => event.type),
      );
      expect(agent.getHistory().length).toBeGreaterThanOrEqual(4);
    } finally {
      unsubscribe();
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
