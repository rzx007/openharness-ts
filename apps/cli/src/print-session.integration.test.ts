import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  OpenHarnessHttpServer,
  type CreateDaemonAgent,
} from "@openharness/server";
import type { AgentRunHost } from "@openharness/core";

import { runPrintSession } from "./print-session.js";

function captureWrite(stream: NodeJS.WriteStream): {
  chunks: string[];
  spy: { mockRestore(): void };
} {
  const chunks: string[] = [];
  const spy = vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);
  return { chunks, spy };
}

async function withPrintServer(
  createAgent: CreateDaemonAgent,
  run: (input: { server: OpenHarnessHttpServer; url: string; token: string }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ohs-print-integration-"));
  const token = "print-integration-token";
  const server = new OpenHarnessHttpServer({
    token,
    storePath: join(dir, "sessions.db"),
    createAgent,
    logger: () => {},
  });

  try {
    const listen = await server.listen();
    await run({ server, url: listen.url, token });
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function testAgent(
  run: (content: string, host: AgentRunHost) => Promise<void>,
): CreateDaemonAgent {
  return async ({ session }) => ({
    id: session.id,
    async *submitMessage(content, options = {}) {
      await run(typeof content === "string" ? content : "", options.host!);
    },
    async runMessage() { return { output: "", events: [], history: [] }; },
    getHistory: () => [],
    loadHistory: () => {},
    clear: () => {},
    setModel: () => {},
    async compact() { return { history: [], beforeMessageCount: 0, afterMessageCount: 0 }; },
    async remember() { return { skipped: true, writtenIds: [], titles: [] }; },
    getUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
    inspect: () => ({ model: session.model, tools: [], hooks: [], mcpServers: [] }),
    async close() {},
  });
}

describe("runPrintSession daemon integration", () => {
  let exitSpy: MockInstance<(code?: string | number | null) => never>;

  afterEach(() => {
    exitSpy?.mockRestore();
    vi.restoreAllMocks();
  });

  it("uses the real daemon client/server path to render text and exit after completion", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = captureWrite(process.stdout);

    const createAgent = testAgent(async (content, host) => {
      expect(content).toBe("hello daemon");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await host.emitStreamEvent({ type: "text_delta", delta: "hello from real daemon" });
    });

    await withPrintServer(createAgent, async ({ server, url, token }) => {
      await runPrintSession(
        { model: "m", outputStyle: "default" } as never,
        "hello daemon",
        { model: "m", cwd: process.cwd(), daemonUrl: url, daemonToken: token },
      );

      const sessions = server.store.listSessions({ includeArchived: true });
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(server.store.listInputs(session.id).map((input) => input.content)).toEqual(["hello daemon"]);
      expect(server.store.listRuns(session.id).map((run) => run.status)).toEqual(["completed"]);
    });

    expect(stdout.chunks.join("")).toContain("hello from real daemon");
    expect(exitSpy).not.toHaveBeenCalled();
    stdout.spy.mockRestore();
  });

  it("auto-replies to daemon permission requests in print mode", async () => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = captureWrite(process.stdout);
    const stderr = captureWrite(process.stderr);
    const decisions: boolean[] = [];

    const createAgent = testAgent(async (_content, host) => {
      const decision = await host.requestPermission({
        toolName: "Write",
        reason: "edit requested by integration test",
        input: { path: "README.md" },
      });
      const allowed = decision.status === "approved";
      decisions.push(allowed);
      await host.emitStreamEvent({
        type: "text_delta",
        delta: allowed ? "permission approved" : "permission denied",
      });
    });

    await withPrintServer(createAgent, async ({ server, url, token }) => {
      await runPrintSession(
        { model: "m", outputStyle: "default" } as never,
        "try edit",
        { model: "m", cwd: process.cwd(), daemonUrl: url, daemonToken: token },
      );

      const session = server.store.listSessions({ includeArchived: true })[0]!;
      const requests = server.store.listPermissionRequests({ sessionId: session.id });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ toolName: "Write", status: "denied" });
      expect(server.store.listRuns(session.id).map((run) => run.status)).toEqual(["completed"]);
    });

    expect(decisions).toEqual([false]);
    expect(stdout.chunks.join("")).toContain("permission denied");
    expect(stderr.chunks.join("")).toContain("[print] auto-denied permission for Write");
    expect(exitSpy).not.toHaveBeenCalled();
    stdout.spy.mockRestore();
    stderr.spy.mockRestore();
  });
});
