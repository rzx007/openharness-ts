import { describe, expect, it, vi } from "vitest";

import type { OpenHarnessClient } from "../../transport/http-client.js";
import { createInitialClientState } from "../../state/reducer.js";
import {
  LOCAL_COMMAND_DETAILS,
  dispatchSessionCommand,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "../session-commands.js";
import type { CommandCatalogEntry } from "../../types/index.js";

function fakeClient(overrides: Partial<OpenHarnessClient> = {}): OpenHarnessClient {
  return {
    health: vi.fn(async () => ({ ok: true, version: "1.2.3" })),
    ...overrides,
  } as unknown as OpenHarnessClient;
}

function host(partial: {
  client?: OpenHarnessClient;
  emit?: (text: string) => void;
  commandCatalog?: CommandCatalogEntry[];
} = {}) {
  const emitted: string[] = [];
  return {
    emitted,
    host: {
      client: partial.client ?? fakeClient(),
      cwd: "/tmp/project",
      commandCatalog: partial.commandCatalog ?? [],
      clientState: createInitialClientState(),
      busy: false,
      emit: partial.emit ?? ((text: string) => {
        emitted.push(text);
      }),
    },
  };
}

describe("parseSlashLine", () => {
  it("parses command name and args", () => {
    expect(parseSlashLine("/help")).toEqual({ name: "/help", args: "" });
    expect(parseSlashLine("  /provider openai  ")).toEqual({ name: "/provider", args: "openai" });
    expect(parseSlashLine("hello")).toBeNull();
  });
});

describe("mergeCommandDetails", () => {
  it("prefers local details over catalog", () => {
    const merged = mergeCommandDetails([
      { name: "/theme", kind: "session", source: "builtin", description: "Catalog theme" },
      { name: "/help", kind: "session", source: "builtin", description: "Show help" },
    ]);
    const theme = merged.find((entry) => entry.name === "/theme");
    const help = merged.find((entry) => entry.name === "/help");
    expect(theme?.description).toBe(
      LOCAL_COMMAND_DETAILS.find((entry) => entry.name === "/theme")?.description,
    );
    expect(help?.description).toBe("Show help");
  });
});

describe("resolveSessionCwd", () => {
  it("prefers status cwd, then daemon cwd, then fallback", () => {
    expect(resolveSessionCwd({ statusCwd: "/a", daemonCwd: "/b", fallback: "/c" })).toBe("/a");
    expect(resolveSessionCwd({ statusCwd: "", daemonCwd: "/b", fallback: "/c" })).toBe("/b");
    expect(resolveSessionCwd({ fallback: "/c" })).toBe("/c");
  });
});

describe("dispatchSessionCommand", () => {
  it("emits Available commands for /help", async () => {
    const { host: h, emitted } = host({
      commandCatalog: [
        { name: "/help", kind: "session", source: "builtin", description: "Show help" },
      ],
    });
    const outcome = await dispatchSessionCommand({ name: "/help", args: "" }, h);
    expect(outcome).toBe("handled");
    expect(emitted[0]).toContain("Available commands:");
    expect(emitted[0]).toContain("/help");
  });

  it("calls health and emits for /version", async () => {
    const client = fakeClient();
    const { host: h, emitted } = host({ client });
    const outcome = await dispatchSessionCommand({ name: "/version", args: "" }, h);
    expect(outcome).toBe("handled");
    expect(client.health).toHaveBeenCalledOnce();
    expect(emitted[0]).toBe("OpenHarness v1.2.3");
  });

  it("presents read-only command output when a presentation surface is available", async () => {
    const { host: h, emitted } = host();
    const presented: Array<{ title: string; content: string }> = [];
    Object.assign(h, {
      sessionId: "s1",
      model: "m",
      statusSessionId: "s1",
      permissionMode: "default",
      present: (title: string, content: string) => {
        presented.push({ title, content });
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/status", args: "" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(presented[0]?.title).toBe("Status");
    expect(presented[0]?.content).toContain("Session status:");
  });

  it("routes cache-first read commands through the presentation cache host", async () => {
    const getContextPreview = vi.fn(async () => "CONTEXT");
    const client = fakeClient({ getContextPreview });
    const { host: h, emitted } = host({ client });
    const reads: Array<{ key: string; title: string; load: () => Promise<string> }> = [];
    Object.assign(h, {
      present: vi.fn(),
      cacheFirstRead: (request: { key: string; title: string; load: () => Promise<string> }) => {
        reads.push(request);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/context", args: "" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(getContextPreview).not.toHaveBeenCalled();
    expect(reads[0]?.key).toBe("context:/tmp/project");
    expect(reads[0]?.title).toBe("Context");
    await expect(reads[0]!.load()).resolves.toBe("CONTEXT");
    expect(getContextPreview).toHaveBeenCalledWith({ cwd: "/tmp/project" });
  });

  it("routes /context status to the context status reader", async () => {
    const getContextStatus = vi.fn(async () => "STATUS TABLE");
    const client = fakeClient({ getContextStatus });
    const { host: h, emitted } = host({ client });
    const reads: Array<{ key: string; title: string; load: () => Promise<string> }> = [];
    Object.assign(h, {
      present: vi.fn(),
      cacheFirstRead: (request: { key: string; title: string; load: () => Promise<string> }) => {
        reads.push(request);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/context", args: "status" }, h);

    expect(outcome).toBe("handled");
    expect(emitted).toHaveLength(0);
    expect(reads[0]?.key).toBe("context:/tmp/project:status");
    await expect(reads[0]!.load()).resolves.toBe("STATUS TABLE");
    expect(getContextStatus).toHaveBeenCalledWith({ cwd: "/tmp/project" });
  });

  it("returns unhandled for unknown non-local commands", async () => {
    const { host: h, emitted } = host();
    const outcome = await dispatchSessionCommand({ name: "/not-a-real-cmd", args: "" }, h);
    expect(outcome).toBe("unhandled");
    expect(emitted).toHaveLength(0);
  });

  it("returns local_ui for LOCAL /theme", async () => {
    const { host: h } = host();
    const outcome = await dispatchSessionCommand({ name: "/theme", args: "dark" }, h);
    expect(outcome).toBe("local_ui");
  });

  it("returns local_ui for LOCAL /models", async () => {
    const { host: h } = host();
    const outcome = await dispatchSessionCommand({ name: "/models", args: "" }, h);
    expect(outcome).toBe("local_ui");
  });

  it("patches session runtime permissionMode for /plan", async () => {
    const updateSession = vi.fn(async (_id: string, input: { metadata?: Record<string, unknown> }) => ({
      id: "s1",
      cwd: "/tmp",
      title: "TUI",
      model: "m",
      status: "idle",
      metadata: input.metadata ?? {},
      createdAt: 1,
      updatedAt: 2,
    }));
    const patches: Array<Record<string, unknown>> = [];
    const client = fakeClient({ updateSession });
    const { host: h, emitted } = host({ client });
    Object.assign(h, {
      sessionId: "s1",
      patchStatus: (patch: Record<string, unknown>) => {
        patches.push(patch);
      },
    });

    const outcome = await dispatchSessionCommand({ name: "/plan", args: "on" }, h);

    expect(outcome).toBe("handled");
    expect(updateSession).toHaveBeenCalledWith("s1", {
      metadata: { runtime: { permissionMode: "plan" } },
    });
    expect(patches).toEqual([{ permission_mode: "plan" }]);
    expect(emitted[0]).toBe("Permission mode: plan");
  });
});
