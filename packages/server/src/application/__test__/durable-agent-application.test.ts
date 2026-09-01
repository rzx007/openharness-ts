import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { OpenHarnessAgent } from "@openharness/agent-runtime";
import type {
  AgentBackgroundShellHost,
  AgentEvent,
  AgentEventContext,
  AgentEventInput,
  AgentRunHandle,
  AgentRunResult,
  CompactAttachmentsProvider,
  Message,
} from "@openharness/core";
import type { AgentJobHost } from "@openharness/jobs";
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
    setCompactAttachmentsProvider: () => {},
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
  it("把成功 Run 写入的 session checkpoint 提供给 compact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openharness-session-memory-"));
    const previousConfigDir = process.env.OPENHARNESS_CONFIG_DIR;
    process.env.OPENHARNESS_CONFIG_DIR = join(dir, "config");
    const store = new SessionStore({ path: join(dir, "store.db") });
    let compactAttachmentsProvider: CompactAttachmentsProvider | undefined;
    const application = new DaemonApplication({
      store,
      settings: {
        model: "test-model",
        apiFormat: "openai",
        maxTurns: 10,
        permission: { mode: "default" },
        memory: {
          enabled: true,
          sessionMemoryEnabled: true,
          autoExtractEnabled: false,
        },
      },
      createAgent: async (context) => ({
        ...(await createEchoAgent(context)),
        setCompactAttachmentsProvider: (provider) => {
          compactAttachmentsProvider = provider;
        },
      }),
      log: () => {},
    });

    try {
      await application.ready();
      const session = application.sessions.createSession({
        cwd: dir,
        model: "test-model",
      });
      const admission = await application.sessions.admitPrompt(session.id, {
        content: "preserve this checkpoint detail",
      });
      await application.sessions.awaitRun(session.id, admission.run!.id);

      expect(compactAttachmentsProvider).toBeDefined();
      const compactAttachments = await compactAttachmentsProvider!();
      expect(compactAttachments).toMatchObject({
        sessionMemory: expect.stringContaining("preserve this checkpoint detail"),
      });
    } finally {
      await application.close().catch(() => {});
      store.close();
      if (previousConfigDir === undefined) delete process.env.OPENHARNESS_CONFIG_DIR;
      else process.env.OPENHARNESS_CONFIG_DIR = previousConfigDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("让模型工具创建的后台 shell 立即进入统一 Jobs，并可被取消", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openharness-background-shell-"));
    const store = new SessionStore({ path: join(dir, "store.db") });
    let backgroundShellHost: AgentBackgroundShellHost | undefined;
    let backgroundShellJobs: AgentJobHost | undefined;
    let terminalJobs: AgentJobHost | undefined;
    const application = new DaemonApplication({
      store,
      createAgent: async (context) => {
        const backgroundShell = context.options.capabilityOverrides?.backgroundShell;
        const terminal = context.options.capabilityOverrides?.terminal;
        if (backgroundShell && backgroundShell !== false) {
          backgroundShellHost = backgroundShell.value;
          backgroundShellJobs = backgroundShell.jobs;
        }
        if (terminal && terminal !== false) terminalJobs = terminal.jobs;
        return await createEchoAgent(context);
      },
      log: () => {},
    });

    try {
      await application.ready();
      const session = application.sessions.createSession({
        cwd: process.cwd(),
        model: "test-model",
      });
      const admission = await application.sessions.admitPrompt(session.id, { content: "initialize" });
      await application.sessions.awaitRun(session.id, admission.run!.id);

      expect(backgroundShellJobs).not.toBe(terminalJobs);

      const created = await backgroundShellHost!.create({
        requestId: "tool:durable-shell-test",
        cwd: session.cwd,
        sessionId: session.id,
        command: `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
        description: "long-running test server",
      });

      await expect(backgroundShellJobs!.list({
        sessionId: session.id,
        includeFinished: true,
      })).resolves.toEqual([
        expect.objectContaining({ id: created.jobId, kind: "shell" }),
      ]);
      await expect(terminalJobs!.list({
        sessionId: session.id,
        includeFinished: true,
      })).resolves.toEqual([]);

      await expect(application.jobs.read({
        sessionId: session.id,
        jobId: created.jobId,
      })).resolves.toMatchObject({
        snapshot: {
          id: created.jobId,
          kind: "shell",
          status: "running",
          ownerSession: session.id,
        },
      });
      await expect(application.jobs.list({ sessionId: session.id })).resolves.toContainEqual(
        expect.objectContaining({ id: created.jobId, kind: "shell" }),
      );
      await expect(application.jobs.cancel({
        sessionId: session.id,
        jobId: created.jobId,
        reason: "test complete",
      })).resolves.toMatchObject({ id: created.jobId, status: "killed" });
    } finally {
      await application.close().catch(() => {});
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("让不同外部聊天使用不同 Session，并对重复平台消息复用同一个 Run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openharness-channel-application-"));
    const path = join(dir, "store.db");
    let store = new SessionStore({ path });
    let application = new DaemonApplication({
      store,
      createAgent: createEchoAgent,
      log: () => {},
    });
    const message = {
      connector: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      content: "hello from bot",
      cwd: process.cwd(),
      model: "test-model",
    };
    try {
      await application.ready();
      const [first, duplicate] = await Promise.all([
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
        }),
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
        }),
      ]);
      const otherChat = await application.channels.handleMessage({
        ...message,
        externalMessageId: "message-2",
        chatId: "chat-2",
      });

      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.delivery.runId).toBe(first.delivery.runId);
      expect(duplicate.delivery.id).toBe(first.delivery.id);
      expect(otherChat.conversation.sessionId).not.toBe(
        first.conversation.sessionId,
      );
      await expect(
        application.channels.handleMessage({
          ...message,
          chatId: "chat-1",
          content: "changed body with the same platform id",
        }),
      ).rejects.toThrow("Prompt id is already used");

      await application.sessions.archiveSessionTree(
        first.conversation.sessionId,
      );
      const afterArchive = await application.channels.handleMessage({
        ...message,
        chatId: "chat-1",
        externalMessageId: "message-3",
      });
      expect(afterArchive.conversation.sessionId).not.toBe(
        first.conversation.sessionId,
      );

      await application.close();
      store.close();
      store = new SessionStore({ path });
      application = new DaemonApplication({
        store,
        createAgent: createEchoAgent,
        log: () => {},
      });
      await application.ready();
      expect(
        application.channels.status({ connector: "feishu" }).conversations,
      ).toContainEqual(
        expect.objectContaining({
          chatId: "chat-1",
          sessionId: afterArchive.conversation.sessionId,
        }),
      );
    } finally {
      await application.close().catch(() => {});
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
