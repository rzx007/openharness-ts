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

  it("closes Agent -> TaskWait without a daemon task projection", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-sdk-child-"));
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        if (firstUserText === "do delegated sdk work") {
          yield { type: "text_delta" as const, delta: "child sdk result" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        const toolResults = params.messages.filter((message) => message.type === "tool_result");
        if (toolResults.length === 0) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-agent-tool",
              name: "Agent",
              input: { description: "sdk child", prompt: "do delegated sdk work" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }
        if (toolResults.length === 1) {
          const text = toolResults[0]!.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          const taskId = text.match(/task_id=([^,)\s]+)/)?.[1];
          if (!taskId) throw new Error(`Agent tool did not return task_id: ${text}`);
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-task-wait-tool",
              name: "TaskWait",
              input: { taskIds: [taskId], timeoutSeconds: 2 },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        const waitText = toolResults.at(-1)!.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        yield { type: "text_delta" as const, delta: `root received: ${waitText}` };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const settings: Settings = {
      apiFormat: "anthropic",
      model: "sdk-child-test-model",
      maxTurns: 4,
      permission: { mode: "full_auto" },
      sandbox: { enabled: false },
    };
    const agent = await createOpenHarnessAgent({
      cwd,
      settings,
      client,
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("delegate work").result;

      expect(result.output).toContain("child sdk result");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events.filter((event) => event.type === "tool.completed")).toHaveLength(2);
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("runs Workflow through framework children without daemon services", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-sdk-workflow-"));
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        if (firstUserText === "do workflow sdk work") {
          yield { type: "text_delta" as const, delta: "workflow child result" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        const toolResult = params.messages.find((message) => message.type === "tool_result");
        if (!toolResult || toolResult.type !== "tool_result") {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "sdk-workflow-tool",
              name: "Workflow",
              input: {
                mode: "sequential",
                persist: false,
                tasks: [{ id: "sdk-worker", prompt: "do workflow sdk work" }],
              },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        const workflowResult = toolResult.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        yield { type: "text_delta" as const, delta: workflowResult };
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const agent = await createOpenHarnessAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-workflow-test-model",
        maxTurns: 3,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("run workflow").result;

      expect(result.output).toContain("workflow child result");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events.some((event) => event.type === "tool.completed")).toBe(true);
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
