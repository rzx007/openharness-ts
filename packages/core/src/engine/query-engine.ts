import type { Message, StreamEvent, ToolUseBlock } from "../index";
import type {
  StreamingMessageClient,
  ToolRegistry as IToolRegistry,
  IPermissionChecker,
  IHookExecutor,
  QueryEngine as IQueryEngine,
  QueryEngineOptions,
  ToolContext,
} from "../index";
import { CompactService } from "./compact-service";

export class QueryEngine implements IQueryEngine {
  private messages: Message[] = [];
  private compactService: CompactService;

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
  }

  async *submitMessage(content: string): AsyncIterable<StreamEvent> {
    this.messages.push({ type: "user", content });

    const maxTurns = this.options.maxTurns ?? 50;
    let turnCount = 0;

    await this.hookExecutor.execute("session_start", {});

    while (turnCount < maxTurns) {
      this.messages = await this.compactService.autoCompact(this.messages);

      const tools = this.toolRegistry.getAll();
      const stream = this.apiClient.streamMessage({
        model: this.options.model ?? "claude-sonnet-4-20250514",
        messages: this.messages,
        system: this.options.systemPrompt,
        tools: tools.length > 0 ? tools : undefined,
      });

      let assistantText = "";
      const toolUses: ToolUseBlock[] = [];
      let stopReason = "";

      for await (const event of stream) {
        yield event;

        if (event.type === "text_delta") {
          assistantText += event.delta;
        } else if (event.type === "tool_use_start") {
          toolUses.push(event.toolUse);
        } else if (event.type === "complete") {
          stopReason = event.stopReason;
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

  private async executeTools(toolUses: ToolUseBlock[]) {
    const results = [];

    for (const toolUse of toolUses) {
      const decision = await this.permissionChecker.checkTool(
        toolUse.name,
        toolUse.input
      );

      if (decision.action === "deny") {
        results.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: "Permission denied" }],
          isError: true,
        });
        continue;
      }

      await this.hookExecutor.execute("pre_tool_use", {
        tool: toolUse.name,
        input: toolUse.input,
      });

      const tool = this.toolRegistry.get(toolUse.name);
      if (!tool) {
        results.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [
            { type: "text" as const, text: `Unknown tool: ${toolUse.name}` },
          ],
          isError: true,
        });
        continue;
      }

      try {
        const context: ToolContext = { cwd: process.cwd() };
        const result = await tool.execute(toolUse.input, context);
        results.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          ...result,
        });
      } catch (error) {
        results.push({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        });
      }

      await this.hookExecutor.execute("post_tool_use", {
        tool: toolUse.name,
        result: results[results.length - 1],
      });
    }

    return results;
  }
}
