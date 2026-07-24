import { describe, it, expect } from "vitest";
import { CommandRegistry } from "@openharness/commands";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import {
  buildHostCommandList,
  buildHostCommandDetails,
  runHostSlashCommand,
  matchUserInvocableSkill,
  buildSkillPrompt,
  buildModelVisibleSkillsList,
  formatSessionMeta,
  messagesToTranscriptItems,
  isNewConversationSlashCommand,
  processLineForHost,
} from "./main";

/** 构造一个最小 SkillDefinition（补齐新增必填字段的默认值）。 */
function makeSkill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: `desc-${partial.name}`,
    content: `# ${partial.name}\nbody`,
    path: "",
    userInvocable: true,
    disableModelInvocation: false,
    ...partial,
  };
}

function makeSkillRegistry(skills: SkillDefinition[]): SkillRegistry {
  const reg = new SkillRegistry();
  for (const s of skills) reg.register(s);
  return reg;
}

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
  reg.register({
    name: "/new",
    description: "new conversation",
    handler: async () => ({ success: true, output: "new conversation" }),
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

describe("buildHostCommandDetails", () => {
  it("returns name + description pairs for registered commands", () => {
    const details = buildHostCommandDetails(makeRegistry());
    const help = details.find((d) => d.name === "/help");
    expect(help).toEqual({ name: "/help", description: "help" });
    const newCmd = details.find((d) => d.name === "/new");
    expect(newCmd?.description).toBe("new conversation");
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

  it("flags clearTranscript for /new (start a new conversation)", async () => {
    const out = await runHostSlashCommand("/new", makeRegistry());
    expect(out.clearTranscript).toBe(true);
    expect(out.output).toBe("new conversation");
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

describe("isNewConversationSlashCommand", () => {
  it("matches /new exactly and with arguments", () => {
    expect(isNewConversationSlashCommand("/new")).toBe(true);
    expect(isNewConversationSlashCommand("/new keep cwd")).toBe(true);
  });

  it("does not match command prefixes that only start with /new", () => {
    expect(isNewConversationSlashCommand("/newer")).toBe(false);
    expect(isNewConversationSlashCommand("/new-session")).toBe(false);
  });
});

const isBuiltin = (reg: CommandRegistry) => (name: string) => reg.get(name) !== undefined;

describe("matchUserInvocableSkill", () => {
  it("matches a user-invocable skill by /<name> and returns args", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/commit fix the parser bug", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe("commit");
    expect(m!.args).toBe("fix the parser bug");
  });

  it("matches with no args (empty args string)", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "review" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/review", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.args).toBe("");
  });

  it("does not override a builtin command (builtin wins, e.g. /help)", () => {
    // 注册一个与内置命令同名的 skill，仍应不命中（内置优先）。
    const skills = makeSkillRegistry([makeSkill({ name: "help" })]);
    const cmds = makeRegistry(); // contains /help
    const m = matchUserInvocableSkill("/help", skills, isBuiltin(cmds));
    expect(m).toBeNull();
  });

  it("does not match a non-user-invocable skill", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "secret", userInvocable: false })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/secret", skills, isBuiltin(cmds));
    expect(m).toBeNull();
  });

  it("returns null for unknown skill names", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    expect(matchUserInvocableSkill("/nope", skills, isBuiltin(cmds))).toBeNull();
  });

  it("matches by commandName when set", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "do-thing", commandName: "dt" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/dt args", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe("do-thing");
    expect(m!.args).toBe("args");
  });

  it("returns null for non-slash input", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    expect(matchUserInvocableSkill("commit", skills, isBuiltin(cmds))).toBeNull();
  });
});

describe("buildSkillPrompt", () => {
  it("uses skill.content and appends args when present", () => {
    const skill = makeSkill({ name: "commit", content: "# commit\nDo the commit thing." });
    const prompt = buildSkillPrompt(skill, "scope=auth");
    expect(prompt).toContain("Do the commit thing.");
    expect(prompt).toContain("## Arguments");
    expect(prompt).toContain("scope=auth");
  });

  it("returns skill.content unchanged when args is empty", () => {
    const skill = makeSkill({ name: "commit", content: "# commit\nbody" });
    const prompt = buildSkillPrompt(skill, "");
    expect(prompt).toBe("# commit\nbody");
    expect(prompt).not.toContain("## Arguments");
  });
});

describe("buildHostCommandList with skills", () => {
  it("appends /<name> for user-invocable skills (incl. disableModelInvocation)", () => {
    const skills = makeSkillRegistry([
      makeSkill({ name: "commit" }),
      makeSkill({ name: "stealth", disableModelInvocation: true }),
    ]);
    const list = buildHostCommandList(makeRegistry(), skills);
    expect(list).toContain("/commit");
    // disableModelInvocation 只挡模型不挡用户：命令列表仍含它。
    expect(list).toContain("/stealth");
  });

  it("does not duplicate builtin command names (builtin wins)", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "help" })]);
    const list = buildHostCommandList(makeRegistry(), skills);
    expect(list.filter((n) => n === "/help")).toHaveLength(1);
  });

  it("omits non-user-invocable skills", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "secret", userInvocable: false })]);
    const list = buildHostCommandList(makeRegistry(), skills);
    expect(list).not.toContain("/secret");
  });

  it("returns only registry commands when no skillRegistry passed", () => {
    const list = buildHostCommandList(makeRegistry());
    expect(list).toContain("/help");
    expect(list).not.toContain("/commit");
  });
});

describe("buildModelVisibleSkillsList", () => {
  it("excludes disableModelInvocation skills (model visibility)", () => {
    const skills = makeSkillRegistry([
      makeSkill({ name: "commit" }),
      makeSkill({ name: "stealth", disableModelInvocation: true }),
    ]);
    const list = buildModelVisibleSkillsList(skills);
    const names = list.map((s) => s.name);
    expect(names).toContain("commit");
    expect(names).not.toContain("stealth");
  });

  it("includes name and description for visible skills", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit", description: "do commit" })]);
    const list = buildModelVisibleSkillsList(skills);
    expect(list).toEqual([{ name: "commit", description: "do commit" }]);
  });
});

describe("formatSessionMeta", () => {
  it("includes message count and model, pluralizes msgs", () => {
    const meta = formatSessionMeta({ created_at: 0, message_count: 3, model: "claude-opus" });
    expect(meta).toContain("3 msgs");
    expect(meta).toContain("claude-opus");
  });

  it("uses singular 'msg' for one message", () => {
    const meta = formatSessionMeta({ created_at: 0, message_count: 1, model: "" });
    expect(meta).toContain("1 msg");
    expect(meta).not.toContain("1 msgs");
  });

  it("omits model segment when empty", () => {
    const meta = formatSessionMeta({ created_at: 0, message_count: 2, model: "" });
    expect(meta).toBe("2 msgs");
  });
});

describe("messagesToTranscriptItems", () => {
  it("maps string-content user and assistant messages", () => {
    const items = messagesToTranscriptItems([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
    expect(items).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  it("maps text/tool_use/tool_result content blocks", () => {
    const items = messagesToTranscriptItems([
      { role: "assistant", content: [
        { type: "text", text: "let me run it" },
        { type: "tool_use", name: "bash", input: { command: "ls" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", content: "file1\nfile2", is_error: false },
      ] },
    ]);
    expect(items[0]).toEqual({ role: "assistant", text: "let me run it" });
    expect(items[1]).toMatchObject({ role: "tool", tool_name: "bash" });
    expect(items[1]!.text).toContain("ls");
    expect(items[2]).toEqual({ role: "tool_result", text: "file1\nfile2", is_error: false });
  });

  it("joins array-form tool_result content and flags errors", () => {
    const items = messagesToTranscriptItems([
      { role: "user", content: [
        { type: "tool_result", content: [{ text: "line1" }, { text: "line2" }], is_error: true },
      ] },
    ]);
    expect(items[0]).toEqual({ role: "tool_result", text: "line1\nline2", is_error: true });
  });

  it("maps stored tool_result messages instead of treating their text blocks as user input", () => {
    const items = messagesToTranscriptItems([
      {
        type: "tool_result",
        toolUseId: "tu-1",
        content: [{ type: "text", text: "dir output" }, { type: "text", text: "file2" }],
        isError: false,
      },
    ]);
    expect(items).toEqual([{ role: "tool_result", text: "dir output\nfile2", is_error: false }]);
  });

  it("replays assistant toolUses from engine history as tool transcript items", () => {
    const items = messagesToTranscriptItems([
      {
        type: "assistant",
        content: "",
        toolUses: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } }],
      },
      {
        type: "tool_result",
        toolUseId: "tu-1",
        content: [{ type: "text", text: "file1" }],
      },
    ]);
    expect(items[0]).toMatchObject({ role: "tool", tool_name: "Bash" });
    expect(items[0]!.text).toContain("ls");
    expect(items[1]).toEqual({ role: "tool_result", text: "file1", is_error: false });
  });

  it("skips empty text blocks and null entries", () => {
    const items = messagesToTranscriptItems([
      null,
      { role: "assistant", content: [{ type: "text", text: "   " }] },
      { role: "user", content: "real" },
    ]);
    expect(items).toEqual([{ role: "user", text: "real" }]);
  });
});

describe("processLineForHost", () => {
  it("flushes streaming assistant text before tool events so realtime order matches history", async () => {
    const emitted: any[] = [];
    const bundle = {
      settings: {},
      queryEngine: {
        async *submitMessage() {
          yield { type: "text_delta", delta: "I will check first." };
          yield {
            type: "tool_use_start",
            toolUse: {
              type: "tool_use",
              id: "tu-1",
              name: "Bash",
              input: { command: "echo ok" },
            },
          };
          yield {
            type: "tool_use_end",
            toolUseId: "tu-1",
            result: {
              toolUseId: "tu-1",
              toolName: "Bash",
              content: [{ type: "text", text: "ok" }],
            },
          };
          yield { type: "text_delta", delta: "Done." };
        },
      },
    };

    await processLineForHost(
      "run it",
      bundle,
      async (event) => { emitted.push(event); },
      new Map(),
      {} as any,
    );

    const transcriptRoles = emitted
      .filter((event) => event.type === "transcript_item" || event.type === "tool_started" || event.type === "tool_completed" || event.type === "assistant_complete")
      .map((event) => event.type === "assistant_complete" ? "assistant_complete" : event.item?.role ?? event.type);

    expect(transcriptRoles).toEqual([
      "user",
      "assistant",
      "tool",
      "tool_result",
      "assistant_complete",
    ]);
    expect(emitted.find((event) => event.type === "transcript_item" && event.item.role === "assistant")?.item.text)
      .toBe("I will check first.");
    expect(emitted.find((event) => event.type === "assistant_complete")?.message)
      .toBe("Done.");
  });
});
