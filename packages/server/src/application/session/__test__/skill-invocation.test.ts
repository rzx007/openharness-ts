import { describe, expect, it } from "vitest";

import { applySkillInvocationToContent } from "../skill-invocation.js";

describe("applySkillInvocationToContent", () => {
  it("turns a selected skill into an explicit native Skill tool instruction", () => {
    expect(applySkillInvocationToContent("画一下系统架构", {
      skillInvocation: {
        name: "archify",
        commandName: "archify",
        source: "user",
        invocationSource: "slash",
      },
    })).toBe(
      '请先使用 Skill 工具加载 "archify" 技能，然后按该技能要求完成下面的任务：\n\n画一下系统架构',
    );
  });

  it("leaves ordinary prompts and unsafe skill names unchanged", () => {
    expect(applySkillInvocationToContent("hello", {})).toBe("hello");
    expect(applySkillInvocationToContent("hello", {
      skillInvocation: { name: "bad\nname", invocationSource: "slash" },
    })).toBe("hello");
    expect(applySkillInvocationToContent("hello", {
      skillInvocation: { name: "archify", invocationSource: "external" },
    })).toBe("hello");
  });

  it("preserves non-text blocks while decorating routed text", () => {
    expect(applySkillInvocationToContent([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: { type: "file", mediaType: "image/png", path: "D:/asset.png" },
      },
    ], {
      skillInvocation: { name: "image-review", invocationSource: "slash" },
    })).toEqual([
      {
        type: "text",
        text: '请先使用 Skill 工具加载 "image-review" 技能，然后按该技能要求完成下面的任务：\n\ndescribe this',
      },
      {
        type: "image",
        source: { type: "file", mediaType: "image/png", path: "D:/asset.png" },
      },
    ]);
  });
});
