import type { ContextEntryRecord } from "./types.js";

export interface ContextPromptOptions {
  maxChars?: number;
  maxEntries?: number;
}

export function renderContextPrompt(
  entries: ContextEntryRecord[],
  options: ContextPromptOptions = {},
): string {
  const maxChars = options.maxChars ?? 12_000;
  const maxEntries = options.maxEntries ?? 40;
  const header = "# Relevant Persistent Context\n\nTreat these as governed durable context. Project rules override general user preferences when they conflict.\n";
  if (header.length > maxChars) return header.slice(0, maxChars);
  let output = header;
  let count = 0;
  for (const entry of entries) {
    if (count >= maxEntries) break;
    const line = `\n- [${entry.id}] (${entry.scope}/${entry.kind}) ${entry.title}: ${entry.content.trim()}`;
    if (output.length + line.length > maxChars) break;
    output += line;
    count += 1;
  }
  return count === 0 ? "" : output;
}
