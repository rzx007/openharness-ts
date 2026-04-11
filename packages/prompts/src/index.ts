import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface PromptContext {
  cwd: string;
  platform: string;
  shell: string;
  date: string;
}

export async function buildSystemPrompt(
  basePrompt: string,
  context: PromptContext
): Promise<string> {
  const claudeMd = await discoverClaudeMd(context.cwd);
  const sections = [basePrompt];

  if (claudeMd) {
    sections.push(`\n# Project Context\n\n${claudeMd}`);
  }

  sections.push(
    `\n# Environment\n- Platform: ${context.platform}`,
    `- Shell: ${context.shell}`,
    `- Date: ${context.date}`,
    `- Working directory: ${context.cwd}`
  );

  return sections.join("\n");
}

export async function discoverClaudeMd(
  projectRoot: string
): Promise<string | null> {
  const candidates = [
    join(projectRoot, "CLAUDE.md"),
    join(projectRoot, ".openharness", "CLAUDE.md"),
  ];

  for (const path of candidates) {
    try {
      await access(path);
      return await readFile(path, "utf-8");
    } catch {
      continue;
    }
  }

  return null;
}
