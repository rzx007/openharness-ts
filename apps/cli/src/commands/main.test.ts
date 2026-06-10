import { describe, it, expect } from "vitest";
import { CommandRegistry } from "@openharness/commands";
import { SkillRegistry, type SkillDefinition } from "@openharness/skills";
import {
  buildHostCommandList,
  runHostSlashCommand,
  matchUserInvocableSkill,
  buildSkillPrompt,
  buildModelVisibleSkillsList,
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
