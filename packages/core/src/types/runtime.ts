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
  /** 设置/清除 per-turn 记忆检索回调；传 undefined 清除（恢复无记忆注入）。 */
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void;
}

export interface PermissionPrompt {
  (toolName: string, reason?: string): Promise<boolean>;
}

/**
 * 按本轮用户输入检索相关记忆的回调（per-turn）。
 *
 * 在 {@link QueryEngine.submitMessage} 流程里、调用 API 之前被调用，参数为本轮
 * 用户输入。返回值会作为**瞬态上下文**附加到本轮发往 API 的 system 提示中，
 * 不会写入持久消息历史，也不会改写引擎常驻的 systemPrompt。
 *
 * 返回 `null`/空串表示本轮无相关记忆可注入。检索方负责在其内部对命中的记忆
 * 调用 `markMemoryUsed` 记使用（引擎不感知记忆存储）。
 */
export interface MemoryRetriever {
  (userInput: string): Promise<string | null> | string | null;
}

export interface QueryEngineOptions {
  maxTurns?: number;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  compactKeepRecent?: number;
  permissionPrompt?: PermissionPrompt;
  skillRegistry?: unknown;
  /**
   * 可选的 per-turn 记忆检索回调。缺省不传时行为与未启用前完全一致。
   * 详见 {@link MemoryRetriever}。
   */
  memoryRetriever?: MemoryRetriever;
}

export class RuntimeBundle {
  constructor(
    public settings: Settings,
    public apiClient: StreamingMessageClient,
    public toolRegistry: ToolRegistry,
    public permissionChecker: PermissionChecker,
    public hookExecutor: HookExecutor,
    public queryEngine: QueryEngine,
  ) {}

  switchApiClient(newClient: StreamingMessageClient): void {
    this.apiClient = newClient;
  }
}
