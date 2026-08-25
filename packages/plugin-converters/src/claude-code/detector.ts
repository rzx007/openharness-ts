import { access } from "node:fs/promises";
import { join } from "node:path";
import type { DetectionResult } from "../core/converter.js";
const exists = async (path: string) => access(path).then(() => true, () => false);
export async function detectClaudeCodePlugin(root: string): Promise<DetectionResult | null> {
  const evidence: string[] = [];
  if (await exists(join(root, ".claude-plugin", "plugin.json"))) evidence.push(".claude-plugin/plugin.json");
  for (const name of ["skills", "commands", "agents", "hooks", ".mcp.json", "SKILL.md"]) if (await exists(join(root, name))) evidence.push(name);
  if (!evidence.length || (evidence.length === 1 && evidence[0] === "SKILL.md" && !(await exists(join(root, "SKILL.md"))))) return null;
  return { converterId: "claude-code", confidence: evidence.includes(".claude-plugin/plugin.json") ? 1 : 0.7, evidence };
}
