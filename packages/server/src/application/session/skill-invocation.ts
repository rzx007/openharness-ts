import type { ContentBlock } from "@openharness/core";

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function applySkillInvocationToContent(
  content: string | ContentBlock[],
  metadata: Record<string, unknown>,
): string | ContentBlock[] {
  const name = readSkillName(metadata);
  if (!name) return content;

  if (typeof content === "string") return skillInstruction(name, content);

  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex < 0) {
    return [{ type: "text", text: skillInstruction(name, "") }, ...content];
  }
  return content.map((block, index) =>
    index === textIndex && block.type === "text"
      ? { ...block, text: skillInstruction(name, block.text) }
      : block,
  );
}

function readSkillName(metadata: Record<string, unknown>): string | null {
  const invocation = metadata.skillInvocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return null;
  const record = invocation as Record<string, unknown>;
  if (record.invocationSource !== "slash") return null;
  const value = record.name;
  if (typeof value !== "string") return null;
  const name = value.trim();
  return SKILL_NAME.test(name) ? name : null;
}

function skillInstruction(name: string, task: string): string {
  const prefix = `请先使用 Skill 工具加载 ${JSON.stringify(name)} 技能，然后按该技能要求完成下面的任务：`;
  return task ? `${prefix}\n\n${task}` : prefix;
}
