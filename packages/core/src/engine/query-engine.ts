import type { Message, StreamEvent, ToolUseBlock, UsageSnapshot } from "../index";
import type {
  StreamingMessageClient,
  ToolRegistry as IToolRegistry,
  IPermissionChecker,
  IHookExecutor,
  QueryEngine as IQueryEngine,
  QueryEngineOptions,
  PermissionPrompt,
  ToolContext,
  ToolExecutionResult,
} from "../index";
import { CompactService } from "./compact-service";
import { CostTracker } from "./cost-tracker";

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

  constructor(
    private apiClient: StreamingMessageClient,
    private toolRegistry: IToolRegistry,
    private permissionChecker: IPermissionChecker,
    private hookExecutor: IHookExecutor,
    private options: QueryEngineOptions = {}
  ) {
    this.compactService = new CompactService(
      options.maxTokens ?? 100_000,
      options.compactKeepRecent ?? 10,
    );
    this.costTracker = new CostTracker();
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? "deepchat-chat";
    this.maxTurns = options.maxTurns ?? 50;
    this.permissionPrompt = options.permissionPrompt;
    this.skillRegistry = options.skillRegistry;
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

    let turnCount = 0;

    // 执行会话开始时的钩子函数
    await this.hookExecutor.execute("session_start", {});

    while (turnCount < this.maxTurns) {
      // 自动压缩消息历史以控制上下文长度
      this.messages = await this.compactService.autoCompact(this.messages);

      const tools = this.toolRegistry.getAll();
      const stream = this.apiClient.streamMessage({
        model: this.model,
        messages: this.messages,
        system: this.systemPrompt,
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

    // 当达到最大轮次限制时抛出异常
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
          allowed = await this.permissionPrompt(toolUse.name, decision.reason);
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
          const context: ToolContext = { cwd: process.cwd(), skillRegistry: this.skillRegistry };
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
