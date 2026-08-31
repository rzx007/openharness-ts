import { initializeSoulMd, inspectSoulMd, type PersonalPromptFileDiagnostic } from "@openharness/prompts";

import type { AgentIdentityService } from "../settings-api.js";

export function createDefaultAgentIdentityService(): AgentIdentityService {
  return {
    async status() {
      return { report: formatSoulDiagnostic(await inspectSoulMd()) };
    },
    async init() {
      const result = await initializeSoulMd();
      const diagnostic = await inspectSoulMd();
      const lines = [
        `Personal prompt directory: ${result.configDir}`,
        `Created: ${result.created.length}`,
        ...result.created.map((path) => `  + ${path}`),
        `Skipped existing: ${result.skipped.length}`,
        ...result.skipped.map((path) => `  = ${path}`),
        "",
        formatSoulDiagnostic(diagnostic),
      ];
      return { report: lines.join("\n") };
    },
  };
}

function formatSoulDiagnostic(item: PersonalPromptFileDiagnostic): string {
  const flags = [
    item.truncated ? "truncated" : "",
    item.issues.length > 0 ? `${item.issues.length} issue(s)` : "",
  ].filter(Boolean);
  const lines = ["Agent identity:", `- ${item.file}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`, `  path: ${item.path}`];
  if (item.message) lines.push(`  note: ${item.message}`);
  for (const issue of item.issues) {
    lines.push(`  ${issue.severity}: ${issue.code} - ${issue.message}`);
  }
  return lines.join("\n");
}
