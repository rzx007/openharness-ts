import type { StreamingMessageClient } from "./client";
import type { ToolRegistry } from "./tools";
import type { PermissionChecker } from "./permissions";
import type { HookExecutor } from "./hooks";
import type { Message } from "./messages";
import type { StreamEvent } from "./events";
import type { Settings } from "./settings";

export interface QueryEngine {
  submitMessage(content: string): AsyncIterable<StreamEvent>;
  getHistory(): Message[];
  compact(): Promise<void>;
}

export interface QueryEngineOptions {
  maxTurns?: number;
  systemPrompt?: string;
  model?: string;
}

export interface RuntimeBundle {
  settings: Settings;
  apiClient: StreamingMessageClient;
  toolRegistry: ToolRegistry;
  permissionChecker: PermissionChecker;
  hookExecutor: HookExecutor;
  queryEngine: QueryEngine;
}
