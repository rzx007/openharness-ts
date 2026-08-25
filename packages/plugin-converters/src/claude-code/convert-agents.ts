const MODEL_ALIASES: Record<string, string | undefined> = {
  inherit: undefined,
  haiku: "claude-haiku",
  sonnet: "claude-sonnet",
  opus: "claude-opus",
};

/** 将 Claude agent frontmatter 收紧为 Native Runtime 当前可接受的字段。 */
export function convertClaudeAgentMarkdown(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (end < 0) return content;
  const output: string[] = ["---"];
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) { output.push(line); continue; }
    const key = match[1]!.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    if (["hooks", "mcpservers", "permissionmode"].includes(key)) continue;
    if (key === "model") {
      const source = match[2]!.trim().replace(/^['"]|['"]$/g, "");
      if (source in MODEL_ALIASES) {
        const mapped = MODEL_ALIASES[source]; if (mapped) output.push(`model: ${mapped}`);
        continue;
      }
    }
    output.push(line);
  }
  return [...output, "---", ...lines.slice(end + 1)].join("\n");
}
