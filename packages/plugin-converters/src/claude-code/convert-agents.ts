const MODEL_ALIASES: Record<string, string | undefined> = {
  inherit: undefined,
  haiku: "claude-haiku",
  sonnet: "claude-sonnet",
  opus: "claude-opus",
};

const NATIVE_AGENT_KEYS: Record<string, string> = {
  name: "name",
  description: "description",
  tools: "tools",
  disallowedtools: "disallowedTools",
  model: "model",
  effort: "effort",
  color: "color",
  background: "background",
  initialprompt: "initialPrompt",
  memory: "memory",
  isolation: "isolation",
  maxturns: "maxTurns",
  skills: "skills",
  requiredmcpservers: "requiredMcpServers",
  criticalsystemreminder: "criticalSystemReminder",
};

function quoteYamlString(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

/** 将 Claude agent frontmatter 收紧为 Native Runtime 当前可接受的字段。 */
export function convertClaudeAgentMarkdown(content: string): string {
  if (!content.startsWith("---")) return content;
  const lines = content.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (end < 0) return content;
  const output: string[] = ["---"];
  let activeField: "description" | "keep" | "drop" = "drop";
  let descriptionParts: string[] = [];
  const flushDescription = (): void => {
    if (!descriptionParts.length) return;
    const [first = "", ...rest] = descriptionParts;
    const blockScalar = /^(?:[>|][+-]?)$/.test(first.trim());
    const description = blockScalar
      ? rest.map((line) => line.replace(/^\s+/, "")).join("\n")
      : descriptionParts.join("\n");
    output.push(`description: ${quoteYamlString(description)}`);
    descriptionParts = [];
  };
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) {
      if (activeField === "description") descriptionParts.push(line);
      else if (activeField === "keep") output.push(line);
      continue;
    }
    const key = match[1]!.toLowerCase().replaceAll("-", "").replaceAll("_", "");
    const nativeKey = NATIVE_AGENT_KEYS[key];
    if (!nativeKey) {
      if (activeField === "description") descriptionParts.push(line);
      else activeField = "drop";
      continue;
    }
    flushDescription();
    if (key === "description") {
      activeField = "description";
      descriptionParts.push(match[2]!);
      continue;
    }
    activeField = "keep";
    if (key === "model") {
      const source = match[2]!.trim().replace(/^['"]|['"]$/g, "");
      if (source in MODEL_ALIASES) {
        const mapped = MODEL_ALIASES[source];
        if (mapped) output.push(`model: ${mapped}`);
        else activeField = "drop";
        continue;
      }
    }
    output.push(`${nativeKey}: ${match[2]!}`);
  }
  flushDescription();
  return [...output, "---", ...lines.slice(end + 1)].join("\n");
}
