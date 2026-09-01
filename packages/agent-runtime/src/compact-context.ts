import type {
  CompactContext,
  CompactContextProvider,
} from "@openharness/core";

type CompactContextSource<K extends keyof CompactContext> = () =>
  | CompactContext[K]
  | null
  | undefined
  | Promise<CompactContext[K] | null | undefined>;

export interface CompactContextSources {
  attachmentCatalog?: CompactContextSource<"attachmentCatalog">;
  sessionMemory?: CompactContextSource<"sessionMemory">;
}

export function createCompactContextProvider(
  sources: CompactContextSources,
): CompactContextProvider {
  return async () => {
    const context: CompactContext = {};
    const attachmentCatalog = await sources.attachmentCatalog?.();
    if (attachmentCatalog) context.attachmentCatalog = attachmentCatalog;
    const sessionMemory = await sources.sessionMemory?.();
    if (sessionMemory) context.sessionMemory = sessionMemory;
    return context;
  };
}
