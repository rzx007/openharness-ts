import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("./ensure-daemon.js", () => ({
  ensureLocalDaemon: vi.fn(async () => ({
    url: "http://daemon.test",
    token: "tok",
    pid: 1,
  })),
}));

vi.mock("@openharness/client", async () => {
  const actual = await vi.importActual<typeof import("@openharness/client")>("@openharness/client");
  return {
    ...actual,
    OpenHarnessClient: vi.fn(),
  };
});

import { OpenHarnessClient } from "@openharness/client";
import { ensureLocalDaemon } from "./ensure-daemon.js";
import { rejectPrintContinueResume, runPrintSession } from "./print-session.js";

describe("rejectPrintContinueResume", () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("allows print without continue/resume flags", () => {
    rejectPrintContinueResume({});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when --continue is set", () => {
    rejectPrintContinueResume({ continue: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("exits when --resume is set", () => {
    rejectPrintContinueResume({ resume: "abc" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("runPrintSession", () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("creates a session, admits prompt, renders text, and exits on run completion", async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    const session = {
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    const run = {
      id: "r1",
      sessionId: "s1",
      status: "running",
      metadata: {},
      createdAt: 2,
      updatedAt: 2,
    };
    const completedRun = { ...run, status: "completed", updatedAt: 4 };
    const textPart = {
      id: "p1",
      sessionId: "s1",
      messageId: "m1",
      seq: 1,
      type: "text",
      status: "running",
      text: "",
      metadata: {},
      createdAt: 3,
      updatedAt: 3,
    };

    const Client = OpenHarnessClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => ({
      createSession: vi.fn(async () => session),
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", content: "hi", metadata: {}, createdAt: 2 },
        run,
      })),
      getSessionState: vi.fn(async () => ({
        cursor: 1,
        session,
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        permissions: [],
      })),
      replyPermission: vi.fn(),
      streamEvents: async function* () {
        yield {
          id: "e2",
          seq: 2,
          type: "session.run.updated",
          sessionId: "s1",
          createdAt: 2,
          payload: { run },
        };
        yield {
          id: "e3",
          seq: 3,
          type: "session.message.part.delta",
          sessionId: "s1",
          createdAt: 3,
          payload: {
            sessionId: "s1",
            messageId: "m1",
            partId: "p1",
            field: "text",
            delta: "hello from daemon",
          },
        };
        yield {
          id: "e4",
          seq: 4,
          type: "session.message.part.updated",
          sessionId: "s1",
          createdAt: 4,
          payload: { part: { ...textPart, text: "hello from daemon", status: "completed" } },
        };
        yield {
          id: "e5",
          seq: 5,
          type: "session.run.updated",
          sessionId: "s1",
          createdAt: 5,
          payload: { run: completedRun },
        };
      },
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default" } as never,
      "hi",
      { model: "m", cwd: "/tmp", daemonUrl: "https://daemon.example/", daemonToken: "remote-token" },
    );

    expect(writes.join("")).toContain("hello from daemon");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(ensureLocalDaemon).not.toHaveBeenCalled();
    expect(Client).toHaveBeenCalledWith({ baseUrl: "https://daemon.example", token: "remote-token" });
    stdoutSpy.mockRestore();
  });

  it("writes permissionMode and maxTurns into createSession metadata", async () => {
    const createSession = vi.fn(async () => ({
      id: "s1",
      cwd: "/tmp",
      title: "print",
      model: "m",
      status: "idle",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const Client = OpenHarnessClient as unknown as ReturnType<typeof vi.fn>;
    Client.mockImplementation(() => ({
      createSession,
      admitPrompt: vi.fn(async () => ({
        input: { id: "i1", sessionId: "s1", seq: 1, delivery: "queue", content: "hi", metadata: {}, createdAt: 2 },
        run: { id: "r1", sessionId: "s1", status: "completed", metadata: {}, createdAt: 2, updatedAt: 2 },
      })),
      getSessionState: vi.fn(async () => ({
        cursor: 0,
        session: {
          id: "s1",
          cwd: "/tmp",
          title: "print",
          model: "m",
          status: "idle",
          metadata: {},
          createdAt: 1,
          updatedAt: 1,
        },
        inputs: [],
        messages: [],
        parts: [],
        runs: [],
        permissions: [],
      })),
      replyPermission: vi.fn(),
      streamEvents: async function* () {
        yield {
          id: "e1",
          seq: 1,
          type: "session.run.updated",
          sessionId: "s1",
          createdAt: 3,
          payload: {
            run: { id: "r1", sessionId: "s1", status: "completed", metadata: {}, createdAt: 2, updatedAt: 3 },
          },
        };
      },
    }));

    await runPrintSession(
      { model: "m", outputStyle: "default", permission: { mode: "default" }, maxTurns: 50 } as never,
      "hi",
      {
        model: "m",
        cwd: "/tmp",
        permissionMode: "plan",
        maxTurns: 7,
        systemPrompt: "be brief",
        allowedTools: "Read,Glob",
        effort: "low",
      },
    );

    expect(createSession).toHaveBeenCalledWith({
      cwd: "/tmp",
      model: "m",
      title: "print",
      metadata: {
        permissionMode: "plan",
        maxTurns: 7,
        systemPrompt: "be brief",
        allowedTools: ["Read", "Glob"],
        effort: "low",
      },
    });
  });
});
