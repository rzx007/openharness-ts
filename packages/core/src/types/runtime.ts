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
  clear(): void;
  setSystemPrompt(prompt: string): void;
  setModel(model: string): void;
  setMaxTurns(max: number): void;
  loadMessages(messages: Message[]): void;
  getTotalUsage(): import("./usage").UsageSnapshot;
}

export interface PermissionPrompt {
  (toolName: string, reason?: string): Promise<boolean>;
}

export interface QueryEngineOptions {
  maxTurns?: number;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  compactKeepRecent?: number;
  permissionPrompt?: PermissionPrompt;
}

export interface RuntimeBundle {
  settings: Settings;
  apiClient: StreamingMessageClient;
  toolRegistry: ToolRegistry;
  permissionChecker: PermissionChecker;
  hookExecutor: HookExecutor;
  queryEngine: QueryEngine;
}
