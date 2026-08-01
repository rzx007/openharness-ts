import { describe, expect, it, vi } from "vitest";

import type { OpenHarnessClient } from "./client.js";
import { createInitialClientState } from "./reducer.js";
import {
  LOCAL_COMMAND_DETAILS,
  dispatchSessionCommand,
  mergeCommandDetails,
  parseSlashLine,
  resolveSessionCwd,
} from "./session-commands.js";
import type { CommandCatalogEntry } from "./types.js";

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
    expect(parseSlashLine("  /model gpt-4o  ")).toEqual({ name: "/model", args: "gpt-4o" });
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
});
