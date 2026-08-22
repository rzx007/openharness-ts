import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type {
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentRunHandle,
  AgentRunResult,
  Message,
} from "@openharness/core";
import { SessionStore } from "@openharness/services";

import type { CreateDaemonAgent } from "../../daemon/daemon-agent.js";
import { DaemonApplication } from "../daemon-application.js";

const createEchoAgent: CreateDaemonAgent = async (context) => {
  let history: Message[] = [];
  let sequence = 0;
  let state: OpenHarnessAgent["state"] = "idle";

  const emit = async (
    input: AgentEventInput,
    eventContext: AgentEventContext,
  ): Promise<void> => {
    await context.options.onEvent?.({
      ...input,
      id: `event-${++sequence}`,
      sequence,
      occurredAt: new Date().toISOString(),
      context: eventContext,
    } as AgentEvent);
  };

  const agent: OpenHarnessAgent = {
    id: context.session.id,
    get state() {
      return state;
    },
    children: {
      get: () => undefined,
      getBySessionId: () => undefined,
      list: () => [],
    },
    subscribe: () => () => {},
    submitMessage(content, options = {}) {
      state = "running";
      const ids = options.ids!;
      const eventContext: AgentEventContext = {
        agentId: context.session.id,
        sessionId: context.session.id,
        inputId: ids.inputId,
        runId: ids.runId,
        traceId: ids.traceId,
      };
      let handle!: AgentRunHandle;
      const result = Promise.resolve().then(async (): Promise<AgentRunResult> => {
        const text = typeof content === "string" ? content : "";
        await emit(
          {
            type: "input.accepted",
            data: { content, delivery: options.delivery ?? "queue" },
          },
          eventContext,
        );
        await emit({ type: "run.started", data: {} }, eventContext);
        await emit(
          { type: "output.text.delta", data: { delta: `echo: ${text}` } },
          eventContext,
        );
        await emit(
          { type: "run.completed", data: { output: `echo: ${text}` } },
          eventContext,
        );
        state = "idle";
        return {
          status: "completed",
          output: `echo: ${text}`,
          history,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      });
      handle = {
        id: ids.runId,
        inputId: ids.inputId,
        sessionId: context.session.id,
        traceId: ids.traceId,
        started: Promise.resolve({
          sessionId: context.session.id,
          inputId: ids.inputId,
          runId: ids.runId,
        }),
        result,
        steer: async () => {
          throw new Error("not used in this test");
        },
        interrupt: async () => {},
      };
      return handle;
    },
    async runMessage(content, options) {
      return await this.submitMessage(content, options).result;
    },
    getHistory: () => [...history],
    loadHistory: (messages) => {
      history = [...messages];
    },
    clear: () => {
      history = [];
    },
    setModel: () => {},
    compact: async () => ({
      history,
      beforeMessageCount: history.length,
      afterMessageCount: history.length,
    }),
    remember: async () => ({ skipped: true, writtenIds: [], titles: [] }),
    getUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    inspect: () => ({ model: context.session.model, tools: [], hooks: [], mcpServers: [] }),
    close: async () => {
      state = "closed";
    },
  };
  return agent;
};

describe("DaemonApplication", () => {
  it("不经过 HTTP 也能完成创建会话、提交输入、运行和读取结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openharness-application-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    const application = new DaemonApplication({
      store,
      createAgent: createEchoAgent,
      log: () => {},
    });
    try {
      expect(() =>
        application.sessions.createSession({
          cwd: process.cwd(),
          model: "too-early",
        }),
      ).toThrow("Durable Agent Application is not ready");
      await application.ready();
      const session = application.sessions.createSession({
        cwd: process.cwd(),
        model: "test-model",
      });
      const admission = await application.sessions.admitPrompt(session.id, {
        content: "hello",
      });

      expect(admission.run).toBeDefined();
      await expect(
        application.sessions.awaitRun(session.id, admission.run!.id),
      ).resolves.toEqual({ status: "completed", output: "echo: hello" });
      expect(application.queries.getSessionState(session.id)).toMatchObject({
        session: { id: session.id },
        runs: [{ id: admission.run!.id, status: "completed" }],
      });
      expect(
        application.events.list({ sessionId: session.id }).length,
      ).toBeGreaterThan(0);

      await application.close();
      await application.close();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
