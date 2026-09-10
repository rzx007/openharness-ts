import { describe, expect, it } from "vitest";

import {
  materializeSessionInput,
  type SessionInputSkillCatalog,
} from "../session-input-materializer.js";

const catalog: SessionInputSkillCatalog = {
  resolvePath(path) {
    return {
      "/skills/super/SKILL.md": { name: "using-superpowers", path, displayName: "Using Superpowers" },
      "/skills/plan/SKILL.md": { name: "writing-plans", path, displayName: "Writing Plans" },
    }[path];
  },
};

describe("materializeSessionInput", () => {
  it("keeps readable markers and emits one ordered skill loading instruction", () => {
    const result = materializeSessionInput([
      { type: "text", text: "使用 " },
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
      { type: "text", text: " 写计划 " },
      { type: "skill", name: "writing-plans", path: "/skills/plan/SKILL.md" },
    ], catalog);

    expect(result.text).toBe("使用 $using-superpowers 写计划 $writing-plans");
    expect(result.skills.map((skill) => skill.path)).toEqual([
      "/skills/super/SKILL.md",
      "/skills/plan/SKILL.md",
    ]);
    expect(result.instruction).toBe(
      "用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：\n" +
        "1. using-superpowers (path: /skills/super/SKILL.md)\n" +
        "2. writing-plans (path: /skills/plan/SKILL.md)\n\n" +
        "用户输入：\n使用 $using-superpowers 写计划 $writing-plans",
    );
  });

  it("loads duplicate skill paths once while retaining readable input markers", () => {
    const result = materializeSessionInput([
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
      { type: "text", text: " 然后 " },
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
    ], catalog);

    expect(result.text).toBe("$using-superpowers 然后 $using-superpowers");
    expect(result.skills).toHaveLength(1);
  });

  it("rejects a selected name that no longer matches its catalog path", () => {
    expect(() => materializeSessionInput([
      { type: "skill", name: "writing-plans", path: "/skills/super/SKILL.md" },
    ], catalog)).toThrowError("session_input_skill_catalog_mismatch");
  });

  it("accepts a skill-only input", () => {
    expect(materializeSessionInput([
      { type: "skill", name: "writing-plans", path: "/skills/plan/SKILL.md" },
    ], catalog).text).toBe("$writing-plans");
  });
});
