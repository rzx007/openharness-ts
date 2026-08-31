import type { ContextScope } from "@openharness/context";

import type { ContextConsolidationService } from "../context/context-consolidation-service.js";
import type { DreamService } from "../settings-api.js";

/** Adapts the governed Context consolidator to the existing `/dream` surface. */
export function createDefaultDreamService(options: {
  consolidation: ContextConsolidationService;
  resolveScope(input: { cwd: string; sessionId?: string }): Promise<{ scope: ContextScope; scopeKey: string }> | { scope: ContextScope; scopeKey: string };
}): DreamService {
  return {
    async start({ cwd, sessionId, preview }) {
      const scope = await options.resolveScope({ cwd, ...(sessionId ? { sessionId } : {}) });
      const result = await options.consolidation.consolidate({ ...scope, preview: preview === true });
      const applied = result.results.filter(({ status }) => status === "applied").length;
      const failed = result.results.filter(({ status }) => status === "failed").length;
      return {
        started: true,
        taskId: result.backupId ? `context-consolidation:${result.backupId}` : "context-consolidation:preview",
        consolidation: {
          preview: result.preview,
          operationCount: result.operations.length,
          applied,
          failed,
          ...(result.backupId ? { backupId: result.backupId } : {}),
        },
      };
    },
  };
}
