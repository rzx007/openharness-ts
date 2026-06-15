import type { Message, StreamEvent, ToolUseBlock, UsageSnapshot } from "../index";
import type {
  StreamingMessageClient,
  ToolRegistry as IToolRegistry,
  IPermissionChecker,
  IHookExecutor,
  QueryEngine as IQueryEngine,
  QueryEngineOptions,
  PermissionPrompt,
  MemoryRetriever,
  ToolContext,
  ToolExecutionResult,
} from "../index";
import { CompactService, type CompactClient, type CompactAttachmentsProvider } from "./compact-service";
import { CostTracker } from "./cost-tracker";

const MAX_COMPACT_OUTPUT_TOKENS = 20_000;
const COMPACT_SUMMARIZER_SYSTEM_PROMPT = "You are a conversation summarizer.";

/**
 * Adapt a {@link StreamingMessageClient} into the {@link CompactClient} shape
 * that {@link CompactService} expects for LLM summarization.
 *
 * The summarizer is driven with a single user-role message carrying the
 * compaction prompt, no tools, and a bounded output budget — mirroring the
 * Python `_collect_summary` call (`stream_message(... system_prompt, tools=[],
 * max_tokens=MAX_OUTPUT_TOKENS_FOR_SUMMARY)`). The underlying stream is passed
 * straight through so `CompactService` can aggregate `text_delta` events and
 * surface `error` events as PTL-detectable failures.
 */
function toCompactClient(
  apiClient: StreamingMessageClient,
  model: string,
): CompactClient {
  return {
    submitMessage(content: string): AsyncIterable<StreamEvent> {
      return apiClient.streamMessage({
        model,
        messages: [{ type: "user", content }],
        system: COMPACT_SUMMARIZER_SYSTEM_PROMPT,
        maxTokens: MAX_COMPACT_OUTPUT_TOKENS,
        tools: undefined,
      });
    },
  };
}

export class MaxTurnsExceeded extends Error {
  constructor(public readonly maxTurns: number) {
    super(`Exceeded maximum agentic turns (${maxTurns})`);
    this.name = "MaxTurnsExceeded";
  }
}

export class QueryEngine implements IQueryEngine {
  private messages: Message[] = [];
  private compactService: CompactService;
  private costTracker: CostTracker;
  private systemPrompt: string | undefined;
  private model: string;
  private maxTurns: number;
  private permissionPrompt?: PermissionPrompt;
  private skillRegistry?: unknown;
  private memoryRetriever?: MemoryRetriever;
  private allowedTools: string[] | null = null;
  private mcpManager: unknown = undefined;

  constructor(
    private apiClient: StreamingMessageClient,
    private toolRegistry: IToolRegistry,
    private permissionChecker: IPermissionChecker,
    private hookExecutor: IHookExecutor,
    private options: QueryEngineOptions = {}
  ) {
    this.model = options.model ?? "deepchat-chat";
    this.compactService = new CompactService(
      options.maxTokens ?? 100_000,
      options.compactKeepRecent ?? 10,
      {
        hookExecutor: this.hookExecutor,
        client: toCompactClient(this.apiClient, this.model),
      },
    );
    this.costTracker = new CostTracker();
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? 50;
    this.permissionPrompt = options.permissionPrompt;
    this.skillRegistry = options.skillRegistry;
    this.memoryRetriever = options.memoryRetriever;
  }

  /**
   * 设置/替换 per-turn 记忆检索回调。传入 undefined 可清除（恢复无记忆注入行为）。
   * 详见 {@link MemoryRetriever}。
   */
  setMemoryRetriever(retriever: MemoryRetriever | undefined): void {
    this.memoryRetriever = retriever;
  }

  /** 注册 compact 附件提供者（B.2）：compact 时注入 taskFocus/plan 等结构化上下文。 */
  setAttachmentsProvider(fn: CompactAttachmentsProvider | undefined): void {
    this.compactService.setAttachmentsProvider(fn);
  }

  setAllowedTools(tools: string[] | null): void {
    this.allowedTools = tools;
  }

  setMcpManager(mgr: unknown): void {
    this.mcpManager = mgr;
  }

  /**
   * 组合本轮发往 API 的 system 提示。
   *
   * 把常驻 systemPrompt 与本轮检索到的相关记忆（瞬态）拼接，仅用于这一次
   * streamMessage 调用，不写入 this.systemPrompt，也不进入 this.messages。
   * 注入风格参考 Python 的「# Relevant Memories」段（追加在 system 末尾）。
   */
  private composeTurnSystemPrompt(memoryContext: string | null): string | undefined {
    if (!memoryContext || !memoryContext.trim()) {
      return this.systemPrompt;
    }
    const reminder = `<system-reminder>\n${memoryContext.trim()}\n</system-reminder>`;
    if (this.systemPrompt && this.systemPrompt.trim()) {
      return `${this.systemPrompt}\n\n${reminder}`;
    }
    return reminder;
  }

  /**
   * 提交用户消息并处理与 AI 助手的交互流程，支持流式响应和工具调用。
   * 该方法会将用户消息加入历史记录，执行会话开始钩子，并在最大轮次限制内循环处理 AI 响应。
   * 如果 AI 返回工具调用请求，会自动执行工具并将结果反馈给 AI，直到不再需要工具调用或达到最大轮次。
   *
   * @param content - 用户发送的消息内容
   * @returns 一个异步迭代器，yield 出流式事件（StreamEvent），包括文本增量、工具使用开始/结束、用量信息等
   */
  async *submitMessage(content: string): AsyncIterable<StreamEvent> {
    this.messages.push({ type: "user", content });

    // per-turn 相关记忆检索：按本轮用户输入选相关记忆，作为瞬态上下文。
    // 仅在本轮（这次 submitMessage）拼进发往 API 的 system，不污染持久历史，
    // 也不改写常驻 systemPrompt。缺省未设 retriever 时该值为 undefined，
    // turnSystemPrompt 退化为 this.systemPrompt，行为与之前完全一致。
    let memoryContext: string | null = null;
    if (this.memoryRetriever) {
      try {
        memoryContext = await this.memoryRetriever(content);
      } catch {
        // retriever failure is non-fatal; continue without memory context
      }
    }
    const turnSystemPrompt = this.composeTurnSystemPrompt(memoryContext);

    let turnCount = 0;

    // 执行会话开始时的钩子函数
    await this.hookExecutor.execute("session_start", {});

    while (turnCount < this.maxTurns) {
      // 自动压缩消息历史以控制上下文长度
      try {
        this.messages = await this.compactService.autoCompact(this.messages);
      } catch {
        // compact failure is non-fatal; continue with current messages
      }

      const allTools = this.toolRegistry.getAll();
      const tools = this.allowedTools
        ? allTools.filter((t) => this.allowedTools!.includes(t.name))
        : allTools;
      const stream = this.apiClient.streamMessage({
        model: this.model,
        messages: this.messages,
        system: turnSystemPrompt,
        tools: tools.length > 0 ? tools : undefined,
      });

      let assistantText = "";
      const toolUses: ToolUseBlock[] = [];

      // 处理流式响应事件，累积文本和工具调用信息
      for await (const event of stream) {
        yield event;

        if (event.type === "text_delta") {
          assistantText += event.delta;
        } else if (event.type === "tool_use_start") {
          toolUses.push(event.toolUse);
        } else if (event.type === "usage") {
          this.costTracker.addUsage(event.usage);
        }
      }

      // 如果助手有文本回复或工具调用，则将其添加到消息历史中
      if (assistantText || toolUses.length > 0) {
        this.messages.push({
          type: "assistant",
          content: assistantText,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });
      }

      // 如果没有工具调用，则结束当前交互流程
      if (toolUses.length === 0) return;

      // 执行所有请求的工具调用，并将结果作为工具结果消息加入历史记录
      const results = await this.executeTools(toolUses);
      for (const result of results) {
        this.messages.push({
          type: "tool_result",
          toolUseId: result.toolUseId,
          content: result.content,
          isError: result.isError,
        });
        yield { type: "tool_use_end", toolUseId: result.toolUseId, result };
      }

      turnCount++;
    }

    // 达到最大轮次：移除末尾的 tool_result 消息（它们没有对应的后续 assistant 回复），
    // 避免下次 submitMessage 时向 API 发送末尾为 tool_result 的非法历史序列。
    while (this.messages.length > 0 && this.messages[this.messages.length - 1]!.type === "tool_result") {
      this.messages.pop();
    }
    throw new MaxTurnsExceeded(this.maxTurns);
  }

  getHistory(): Message[] {
    return [...this.messages];
  }

  async compact(): Promise<void> {
    const microResult = this.compactService.microCompact(this.messages);
    if (this.compactService.estimateTokens(microResult) < (this.options.maxTokens ?? 100_000)) {
      this.messages = microResult;
      return;
    }
    this.messages = await this.compactService.autoCompact(this.messages);
  }

  clear(): void {
    this.messages = [];
    this.costTracker.reset();
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setModel(model: string): void {
    this.model = model;
    // Keep the summarizer client pointed at the current model.
    this.compactService.setClient(toCompactClient(this.apiClient, this.model));
  }

  setMaxTurns(max: number): void {
    this.maxTurns = max;
  }

  loadMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  getTotalUsage(): UsageSnapshot {
    return this.costTracker.getTotal();
  }

  /**
   * 执行一组工具调用请求，并在执行前进行权限检查、钩子拦截及用户确认。
   * 
   * 该函数会并行检查所有工具的权限，并根据检查结果决定是直接拒绝、询问用户还是继续执行。
   * 对于允许执行的工具，会在执行前后触发相应的生命周期钩子（pre_tool_use 和 post_tool_use）。
   * 最终返回与输入顺序对应的执行结果数组。
   *
   * @param toolUses - 需要执行的工具调用块数组，包含工具名称、输入参数等信息。
   * @returns 一个 Promise，解析为工具执行结果数组。每个结果对应输入数组中的一个工具调用，
   *          包含工具ID、名称、执行内容（或错误信息）以及是否出错的标志。
   */
  private async executeTools(toolUses: ToolUseBlock[]): Promise<ToolExecutionResult[]> {
    // 并行检查所有工具的权限状态
    const checks = await Promise.all(
      toolUses.map((tu) =>
        this.permissionChecker.checkTool(tu.name, tu.input)
      )
    );

    const executable: { idx: number; toolUse: ToolUseBlock }[] = [];
    const results: ToolExecutionResult[] = new Array(toolUses.length);

    for (let i = 0; i < toolUses.length; i++) {
      const toolUse = toolUses[i]!;
      const decision = checks[i]!;

      // 处理权限被直接拒绝的情况
      if (decision.action === "deny") {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: `Permission denied: ${decision.reason ?? "not allowed"}` }],
          isError: true,
        };
        continue;
      }

      // 处理需要用户确认权限的情况
      if (decision.action === "ask") {
        let allowed = false;
        if (this.permissionPrompt) {
          allowed = await this.permissionPrompt(toolUse.name, decision.reason, toolUse.input);
        }
        if (!allowed) {
          results[i] = {
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            content: [{ type: "text" as const, text: `Permission denied by user: ${decision.reason ?? "not confirmed"}` }],
            isError: true,
          };
          continue;
        }
      }

      // 执行工具使用前的钩子，若被钩子拦截则终止执行
      const hookResult = await this.hookExecutor.execute("pre_tool_use", {
        tool: toolUse.name,
        input: toolUse.input,
      });

      if (hookResult.blocked) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: `Blocked by hook: ${hookResult.reason ?? "pre-tool hook blocked execution"}` }],
          isError: true,
        };
        continue;
      }

      // 验证工具是否存在，若不存在则返回错误结果
      const tool = this.toolRegistry.get(toolUse.name);
      if (!tool) {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: `Unknown tool: ${toolUse.name}` }],
          isError: true,
        };
        continue;
      }

      executable.push({ idx: i, toolUse });
    }

    // 并行执行所有通过校验的工具，并捕获执行过程中的异常
    const execResults = await Promise.all(
      executable.map(async ({ idx, toolUse }) => {
        const tool = this.toolRegistry.get(toolUse.name)!;
        try {
          const context: ToolContext = { cwd: process.cwd(), skillRegistry: this.skillRegistry, mcpManager: this.mcpManager };
          const result = await tool.execute(toolUse.input, context);
          return { idx, result: { toolUseId: toolUse.id, toolName: toolUse.name, ...result } as ToolExecutionResult };
        } catch (error) {
          return {
            idx,
            result: {
              toolUseId: toolUse.id,
              toolName: toolUse.name,
              content: [{ type: "text" as const, text: String(error) }],
              isError: true,
            } as ToolExecutionResult,
          };
        }
      })
    );

    // 将执行结果回填至结果数组，并执行工具使用后的钩子
    for (const { idx, result } of execResults) {
      results[idx] = result;
      await this.hookExecutor.execute("post_tool_use", {
        tool: result.toolName,
        result,
      });
    }

    return results;
  }
}
