import type { StreamEvent } from "@openharness/core";

export interface RenderOptions {
  verbose?: boolean;
  printMode?: boolean;
}

export class EventRenderer {
  private buffer = "";
  private currentTool: string | null = null;

  constructor(private options: RenderOptions = {}) {}

  async render(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "text_delta":
        this.renderText(event.delta);
        break;
      case "tool_use_start":
        this.renderToolStart(event.toolUse.name, event.toolUse.input);
        break;
      case "tool_use_end":
        this.renderToolEnd(event.toolUseId, event.result.content, event.result.isError);
        break;
      case "usage":
        if (this.options.verbose) {
          this.renderUsage(event.usage);
        }
        break;
      case "complete":
        this.renderComplete(event.stopReason);
        break;
      case "error":
        this.renderError(event.error);
        break;
    }
  }

  private renderText(delta: string): void {
    if (this.currentTool) {
      process.stdout.write("\n");
      this.currentTool = null;
    }
    process.stdout.write(delta);
    this.buffer += delta;
  }

  private renderToolStart(name: string, input: Record<string, unknown>): void {
    const summary = this.summarizeToolInput(name, input);
    process.stdout.write(`\n  ○ ${name}(${summary})\n`);
    this.currentTool = name;
  }

  private renderToolEnd(
    _toolUseId: string,
    content: Array<{ type: string; text?: string }>,
    isError?: boolean,
  ): void {
    if (this.options.verbose) {
      const text = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
      if (text) {
        const prefix = isError ? "  ✗ " : "  ✓ ";
        const lines = text.split("\n").slice(0, 5);
        for (const line of lines) {
          process.stdout.write(`${prefix}${line}\n`);
        }
        if (text.split("\n").length > 5) {
          process.stdout.write(`${prefix}... (${text.split("\n").length - 5} more lines)\n`);
        }
      }
    }
    this.currentTool = null;
  }

  private renderUsage(usage: { inputTokens?: number; outputTokens?: number }): void {
    process.stdout.write(
      `\n  [tokens: ${usage.inputTokens ?? 0}in / ${usage.outputTokens ?? 0}out]\n`,
    );
  }

  private renderComplete(stopReason: string): void {
    if (!this.options.printMode) {
      process.stdout.write("\n");
    }
  }

  private renderError(error: Error): void {
    process.stderr.write(`\n  Error: ${error.message}\n`);
  }

  private summarizeToolInput(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case "Bash":
        return truncate(String(input.command ?? ""), 80);
      case "fileRead":
      case "fileWrite":
      case "fileEdit":
        return truncate(String(input.path ?? input.filePath ?? ""), 80);
      case "glob":
      case "grep":
        return truncate(String(input.pattern ?? ""), 80);
      default:
        return truncate(JSON.stringify(input), 80);
    }
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
    this.currentTool = null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
