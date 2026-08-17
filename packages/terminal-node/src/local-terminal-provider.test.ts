import type { TerminalSessionInfo } from "@openharness/terminal";
import { describe, expect, it, vi } from "vitest";

import { LocalTerminalProvider } from "./local-terminal-provider";
import { TerminalOutputStore } from "./terminal-output-store";

describe("LocalTerminalProvider", () => {
  it("observes an exit that happens while wait subscribes", async () => {
    const provider = new LocalTerminalProvider({ resolveCwd: async () => "/repo" });
    const info: TerminalSessionInfo = {
      id: "terminal-1",
      name: "test",
      projectId: "project-1",
      runtime: "local",
      source: "agent",
      sessionId: "session-1",
      status: "running",
      cwd: "/repo",
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    const session = {
      info,
      kind: "pty" as const,
      pty: {},
      output: { drain: vi.fn() },
      transcript: new TerminalOutputStore(),
      cancelRequested: false,
    };
    const internals = provider as unknown as { sessions: Map<string, typeof session> };
    internals.sessions.set(info.id, session);

    const subscribe = provider.subscribe.bind(provider);
    vi.spyOn(provider, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      session.info = {
        ...session.info,
        status: "completed",
        exitedAt: "2026-08-17T00:00:01.000Z",
        exitCode: 0,
      };
      return unsubscribe;
    });

    await expect(provider.wait({ terminalId: info.id, timeoutMs: 100 })).resolves.toMatchObject({
      timedOut: false,
      terminal: { status: "completed" },
    });
  });
});
