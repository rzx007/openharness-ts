import { describe, it, expect } from "vitest";
import { CommandRegistry } from "@openharness/commands";
import { buildHostCommandList, runHostSlashCommand } from "./main";

function makeRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register({
    name: "/help",
    description: "help",
    handler: async () => ({ success: true, output: "HELP TEXT" }),
  });
  reg.register({
    name: "/exit",
    description: "exit",
    handler: async () => ({ success: true, output: "__EXIT__" }),
  });
  reg.register({
    name: "/clear",
    description: "clear",
    handler: async () => ({ success: true, output: "cleared" }),
  });
  return reg;
}

describe("buildHostCommandList", () => {
  it("keeps the single leading slash from registered names (no //help)", () => {
    const list = buildHostCommandList(makeRegistry());
    expect(list).toContain("/help");
    expect(list.every((n) => !n.startsWith("//"))).toBe(true);
  });
});

describe("runHostSlashCommand", () => {
  it("routes a command through the registry and returns its output (never the model)", async () => {
    const out = await runHostSlashCommand("/help", makeRegistry());
    expect(out).toEqual({ output: "HELP TEXT", error: undefined, clearTranscript: false });
    expect(out.exit).toBeUndefined();
  });

  it("signals exit for __EXIT__ output", async () => {
    const out = await runHostSlashCommand("/exit", makeRegistry());
    expect(out.exit).toBe(true);
    expect(out.output).toBeUndefined();
  });

  it("flags clearTranscript for /clear", async () => {
    const out = await runHostSlashCommand("/clear", makeRegistry());
    expect(out.clearTranscript).toBe(true);
    expect(out.output).toBe("cleared");
  });

  it("parses the command name and arguments", async () => {
    const reg = new CommandRegistry();
    let seen: Record<string, string> | undefined;
    let seenRaw: string | undefined;
    reg.register({
      name: "/model",
      description: "model",
      handler: async (ctx) => {
        seen = ctx.args;
        seenRaw = ctx.raw;
        return { success: true, output: "ok" };
      },
    });
    await runHostSlashCommand("/model gpt-4", reg);
    expect(seen?.model).toBe("gpt-4");
    expect(seenRaw).toBe("/model gpt-4");
  });

  it("surfaces an error for an unknown command (still not the model)", async () => {
    const out = await runHostSlashCommand("/nope", makeRegistry());
    expect(out.error).toContain("Unknown command");
    expect(out.exit).toBeUndefined();
  });
});
