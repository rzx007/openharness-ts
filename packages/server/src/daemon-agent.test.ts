import { describe, expect, it, vi } from "vitest";

vi.mock("@openharness/coordinator", () => ({
  getCoordinatorSystemPrompt: () => "You are a **coordinator** test prompt.",
  getCoordinatorTools: () => ["Agent", "SendMessage", "TaskStop", "TaskWait", "Workflow"],
  getCoordinatorUserContext: vi.fn(() => ({
    workerToolsContext: "Workers spawned via the Agent tool have access to these tools: Agent, TaskWait",
  })),
}));

vi.mock("@openharness/agent-runtime", () => ({
  createOpenHarnessAgent: vi.fn(async () => {
    throw new Error("createOpenHarnessAgent should not be used by this test");
  }),
}));

import { createDaemonAgentLoader } from "./daemon-agent.js";
import { getCoordinatorUserContext } from "@openharness/coordinator";

const session = {
  id: "session-1",
  cwd: "/repo",
  model: "model-from-session",
  metadata: {
    permissionMode: "plan",
    systemPrompt: "session prompt",
    maxTurns: 7,
    allowedTools: ["Read", 1],
    disallowedTools: ["Bash", null],
    effort: "high",
  },
} as any;

describe("createDaemonAgentLoader", () => {
  it("returns no loader when the daemon has no Agent configuration", () => {
    expect(createDaemonAgentLoader({})).toBeUndefined();
  });

  it("creates one fully initialized Agent from durable session state", async () => {
    const sink = vi.fn(async () => {});
    const loadHistory = vi.fn();
    const close = vi.fn(async () => {});
    const agent = { loadHistory, close } as any;
    const requestPermission = vi.fn();
    const createAgent = vi.fn(async () => agent);
    const createEventSink = vi.fn(() => sink);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      requestPermission,
      createEventSink,
    })!;

    const loaded = await loader({ session, history: [], parts: [] });

    expect(loaded).toBe(agent);
    expect(createAgent).toHaveBeenCalledOnce();
    const context = createAgent.mock.calls[0]![0];
    expect(context.options).toMatchObject({
      cwd: "/repo",
      sessionId: "session-1",
      model: "model-from-session",
      permissionMode: "plan",
      systemPrompt: "session prompt",
      maxTurns: 7,
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      effort: "high",
      requestPermission,
    });
    expect(loadHistory).toHaveBeenCalledWith([]);
    expect(createEventSink).toHaveBeenCalledWith(agent, session);

    const event = { type: "run.started" } as any;
    await context.options.onEvent(event);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("loads Agent settings for the durable session cwd", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const getSettingsForCwd = vi.fn(async (cwd: string) => ({
      model: "cwd-model",
      sandbox: {
        enabled: cwd === "/repo",
        backend: "docker",
      },
    } as any));
    const loader = createDaemonAgentLoader({
      settings: { model: "global-model", sandbox: { enabled: false } } as any,
      getSettingsForCwd,
      createAgent,
    })!;

    await loader({ session, history: [], parts: [] });

    expect(getSettingsForCwd).toHaveBeenCalledWith("/repo");
    expect(createAgent.mock.calls[0]![0].options.settings).toMatchObject({
      model: "cwd-model",
      sandbox: {
        enabled: true,
        backend: "docker",
      },
    });
  });

  it("turns durable coordinator sessions into coordinator Agents", async () => {
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const createAgent = vi.fn(async () => agent);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
    })!;

    await loader({
      session: {
        ...session,
        metadata: {
          ...session.metadata,
          sessionMode: "coordinator",
          systemPrompt: "Keep updates short.",
          allowedTools: ["Bash"],
        },
      },
      history: [],
      parts: [],
    });

    const options = createAgent.mock.calls[0]![0].options;
    expect(options.systemPrompt).toContain("You are a **coordinator**");
    expect(options.systemPrompt).toContain("## Runtime Context");
    expect(options.systemPrompt).toContain("Workers spawned via the Agent tool");
    expect(options.systemPrompt).toContain("## Additional Session Instructions");
    expect(options.systemPrompt).toContain("Keep updates short.");
    expect(options.allowedTools).toEqual(["Bash"]);
    expect(options.roleAllowedTools).toEqual(["Agent", "SendMessage", "TaskStop", "TaskWait", "Workflow"]);
    expect(getCoordinatorUserContext).toHaveBeenCalledWith(
      [],
      expect.stringContaining(".openharness"),
      { enabled: true, hostToolCeiling: ["Bash"] },
    );
  });

  it("closes a newly created Agent when durable history cannot be restored", async () => {
    const error = new Error("bad history");
    const close = vi.fn(async () => {});
    const agent = { loadHistory: vi.fn(() => { throw error; }), close } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async () => agent),
    })!;

    await expect(loader({ session, history: [], parts: [] })).rejects.toThrow("bad history");
    expect(close).toHaveBeenCalledOnce();
  });

  it("buffers framework events emitted before the daemon sink can bind to the Agent", async () => {
    const event = { type: "run.started" } as any;
    const sink = vi.fn(async () => {});
    const agent = { loadHistory: vi.fn(), close: vi.fn(async () => {}) } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async ({ options }) => {
        await options.onEvent!(event);
        return agent;
      }),
      createEventSink: vi.fn(() => sink),
    })!;

    await expect(loader({ session, history: [], parts: [] })).resolves.toBe(agent);
    expect(sink).toHaveBeenCalledWith(event);
  });

  it("aggregates the history and cleanup errors in lifecycle order", async () => {
    const historyError = new Error("bad history");
    const closeError = new Error("close failed");
    const agent = {
      loadHistory: vi.fn(() => { throw historyError; }),
      close: vi.fn(async () => { throw closeError; }),
    } as any;
    const loader = createDaemonAgentLoader({
      createAgent: vi.fn(async () => agent),
    })!;

    const failure = await loader({ session, history: [], parts: [] }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([historyError, closeError]);
    expect(agent.close).toHaveBeenCalledOnce();
  });
});
