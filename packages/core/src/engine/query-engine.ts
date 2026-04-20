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
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.maxTurns = options.maxTurns ?? 50;
    this.permissionPrompt = options.permissionPrompt;
    this.skillRegistry = options.skillRegistry;
  }

  async *submitMessage(content: string): AsyncIterable<StreamEvent> {
    this.messages.push({ type: "user", content });

    let turnCount = 0;

    await this.hookExecutor.execute("session_start", {});

    while (turnCount < this.maxTurns) {
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

      if (assistantText || toolUses.length > 0) {
        this.messages.push({
          type: "assistant",
          content: assistantText,
          toolUses: toolUses.length > 0 ? toolUses : undefined,
        });
      }

      if (toolUses.length === 0) return;

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

  private async executeTools(toolUses: ToolUseBlock[]): Promise<ToolExecutionResult[]> {
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

      if (decision.action === "deny") {
        results[i] = {
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: `Permission denied: ${decision.reason ?? "not allowed"}` }],
          isError: true,
        };
        continue;
      }

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
