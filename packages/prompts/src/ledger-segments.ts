import type { ContextBucketId, ContextLedgerSegment } from "@openharness/core";
import { buildPromptLayers } from "./index.js";
import type { PromptPermissionMode } from "./index.js";
import type { WorkStyle } from "@openharness/core";

export interface BuildPromptLedgerSegmentsOptions {
  customPrompt?: string;
  cwd?: string;
  permissionMode?: PromptPermissionMode;
  fastMode?: boolean;
  workStyle?: WorkStyle;
  effort?: string;
  passes?: number;
  /** Full project memory preview — excluded from ledger segments by design. */
  memoryContent?: string;
  /** Optional per-turn memory reminder counted toward conversation bucket. */
  memoryReminderText?: string;
  includeDelegation?: boolean;
  includeBackgroundShell?: boolean;
  skillsList?: Array<{ name: string; description: string }>;
}

function classifyStableSegment(text: string): ContextBucketId {
  if (text.includes("# Available Skills")) return "skills";
  if (text.includes("# Delegation And Subagents")) return "subagents";
  return "system";
}

/**
 * Build tagged ledger segments for context-usage estimation.
 * Reuses {@link buildPromptLayers} so model-visible prompt assembly stays unchanged.
 */
export async function buildPromptLedgerSegments(
  options: BuildPromptLedgerSegmentsOptions = {},
): Promise<ContextLedgerSegment[]> {
  const { memoryContent: _memoryContent, memoryReminderText, ...layerOptions } = options;

  const layers = await buildPromptLayers({
    ...layerOptions,
    memoryContent: undefined,
  });

  const segments: ContextLedgerSegment[] = [];

  for (const text of layers.stable) {
    segments.push({ bucket: classifyStableSegment(text), text });
  }
  for (const text of layers.context) {
    segments.push({ bucket: "rules", text });
  }
  for (const text of layers.volatile) {
    segments.push({ bucket: "rules", text });
  }

  const reminder = memoryReminderText?.trim();
  if (reminder) {
    segments.push({ bucket: "conversation", text: reminder });
  }

  return segments;
}
