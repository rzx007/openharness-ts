import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("runs Coordinator -> Workflow -> worker -> Read/Bash/Edit with worker tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-sdk-coordinator-workflow-"));
    const targetFile = join(cwd, "target.txt");
    writeFileSync(targetFile, "alpha\n", "utf-8");
    const events: AgentEvent[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        const usedTools = params.messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.type === "assistant" ? message.toolUses ?? [] : [])
          .map((toolUse) => toolUse.name);

        if (usedTools.includes("Workflow")) {
          const workflowResult = latestToolResultText(params.messages);
          yield { type: "text_delta" as const, delta: `coordinator received ${workflowResult}` };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (usedTools.includes("Read") && usedTools.includes("Bash") && usedTools.includes("Edit")) {
          const workerResults = params.messages
            .filter((message) => message.type === "tool_result")
            .map((message) => message.type === "tool_result"
              ? message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("")
              : "")
            .join("\n");
          expect(workerResults).toContain("1: alpha");
          expect(workerResults).toContain("bash-ok");
          expect(workerResults).toContain("Successfully edited");
          yield { type: "text_delta" as const, delta: "worker completed Read/Bash/Edit" };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (firstUserText.includes("perform real worker tools")) {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-read",
              name: "Read",
              input: { file_path: targetFile },
            },
          };
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-bash",
              name: "Bash",
              input: { command: "echo bash-ok", workdir: cwd, timeout: 10_000 },
            },
          };
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "worker-edit",
              name: "Edit",
              input: { file_path: targetFile, old_string: "alpha", new_string: "beta" },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        yield {
          type: "tool_use_start" as const,
          toolUse: {
            type: "tool_use" as const,
            id: "coordinator-workflow",
            name: "Workflow",
            input: {
              mode: "sequential",
              persist: false,
              waitForCompletion: true,
              tasks: [{
                id: "real-worker-tools",
                prompt: "perform real worker tools",
              }],
            },
          },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };
    const agent = await createOpenHarnessAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-coordinator-workflow-test-model",
        maxTurns: 5,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      roleAllowedTools: ["workflow", "task_wait", "task_stop", "agent", "send_message"],
      onEvent: (event) => { events.push(event); },
    });

    try {
      const result = await agent.submitMessage("run coordinator workflow").result;

      expect(result.output).toContain("worker completed Read/Bash/Edit");
      expect(readFileSync(targetFile, "utf-8")).toBe("beta\n");
      expect(events.some((event) => event.type === "child.created")).toBe(true);
      expect(events
        .filter((event) => event.type === "tool.started")
        .map((event) => event.type === "tool.started" ? event.data.toolUse.name : ""))
        .toEqual(expect.arrayContaining(["Workflow", "Read", "Bash", "Edit"]));
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("keeps child worker tools under the SDK host allowlist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "openharness-sdk-child-ceiling-"));
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        const firstUser = params.messages.find((message) => message.type === "user");
        const firstUserText = firstUser?.type === "user" && typeof firstUser.content === "string"
          ? firstUser.content
          : "";
        const usedTools = params.messages
          .filter((message) => message.type === "assistant")
          .flatMap((message) => message.type === "assistant" ? message.toolUses ?? [] : [])
          .map((toolUse) => toolUse.name);

        if (usedTools.includes("TaskWait")) {
          const waitText = latestToolResultText(params.messages);
          yield { type: "text_delta" as const, delta: waitText };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (usedTools.includes("Agent")) {
          const toolResult = toolResultText(params.messages, "spawn-restricted-child");
          const taskId = toolResult.match(/task_id=([^,)\s]+)/)?.[1];
          if (!taskId) throw new Error(`Agent tool did not return task_id: ${toolResult}`);
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "wait-restricted-child",
              name: "TaskWait",
              input: { taskIds: [taskId], timeoutSeconds: 2 },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        if (usedTools.includes("Bash")) {
          yield { type: "text_delta" as const, delta: latestToolResultText(params.messages) };
          yield { type: "complete" as const, stopReason: "end_turn" };
          return;
        }

        if (firstUserText === "child tries bash") {
          yield {
            type: "tool_use_start" as const,
            toolUse: {
              type: "tool_use" as const,
              id: "forbidden-bash",
              name: "Bash",
              input: { command: "echo should-not-run", workdir: cwd },
            },
          };
          yield { type: "complete" as const, stopReason: "tool_use" };
          return;
        }

        yield {
          type: "tool_use_start" as const,
          toolUse: {
            type: "tool_use" as const,
            id: "spawn-restricted-child",
            name: "Agent",
            input: { description: "restricted child", prompt: "child tries bash" },
          },
        };
        yield { type: "complete" as const, stopReason: "tool_use" };
      },
    };
    const agent = await createOpenHarnessAgent({
      cwd,
      settings: {
        apiFormat: "anthropic",
        model: "sdk-child-ceiling-test-model",
        maxTurns: 5,
        permission: { mode: "full_auto" },
        sandbox: { enabled: false },
      },
      client,
      allowedTools: ["Read", "Agent", "TaskWait"],
    });

    try {
      const result = await agent.submitMessage("spawn restricted worker").result;

      expect(result.output).toContain("Unknown tool: Bash");
      expect(result.output).not.toContain("should-not-run");
    } finally {
      await agent.close();
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

function latestToolResultText(messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"]): string {
  const latest = messages.filter((message) => message.type === "tool_result").at(-1);
  if (!latest || latest.type !== "tool_result") return "";
  return latest.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function toolResultText(
  messages: Parameters<StreamingMessageClient["streamMessage"]>[0]["messages"],
  toolUseId: string,
): string {
  const result = messages.find((message) =>
    message.type === "tool_result" && message.toolUseId === toolUseId
  );
  if (!result || result.type !== "tool_result") return "";
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}
