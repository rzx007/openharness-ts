import type { CommandRegistry } from "@openharness/commands";
import type { QueryEngine } from "@openharness/core";

export function registerBuiltinCommands(
  registry: CommandRegistry,
  getEngine: () => QueryEngine,
  getModel: () => string,
): void {
  registry.register({
    name: "/help",
    description: "Show available commands",
    aliases: ["/h", "/?"],
    handler: async (ctx) => {
      const commands = registry.list();
      const lines = ["Available commands:", ""];
      for (const cmd of commands) {
        const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
        lines.push(`  ${cmd.name}${aliases} - ${cmd.description}`);
      }
      lines.push("", "Type your message to send to the AI agent.");
      lines.push("Use Ctrl+C or type 'exit' to quit.");
      return { success: true, output: lines.join("\n") };
    },
  });

  registry.register({
    name: "/model",
    description: "Show or change the current model",
    args: [{ name: "model", description: "New model name", required: false }],
    handler: async (ctx) => {
      const newModel = ctx.args.model;
      if (newModel) {
        getEngine().setModel(newModel);
        return { success: true, output: `Model changed to: ${newModel}` };
      }
      return { success: true, output: `Current model: ${getModel()}` };
    },
  });

  registry.register({
    name: "/clear",
    description: "Clear conversation history",
    handler: async (ctx) => {
      getEngine().clear();
      return { success: true, output: "Conversation cleared." };
    },
  });

  registry.register({
    name: "/compact",
    description: "Summarize conversation to reduce context size",
    handler: async (ctx) => {
      await getEngine().compact();
      return { success: true, output: "Conversation compacted." };
    },
  });

  registry.register({
    name: "/usage",
    description: "Show token usage statistics",
    handler: async (ctx) => {
      const usage = getEngine().getTotalUsage();
      const lines = [
        "Token usage:",
        `  Input:  ${usage.inputTokens.toLocaleString()}`,
        `  Output: ${usage.outputTokens.toLocaleString()}`,
        `  Total:  ${(usage.inputTokens + usage.outputTokens).toLocaleString()}`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  registry.register({
    name: "/session",
    description: "Show session info",
    handler: async (ctx) => {
      const usage = getEngine().getTotalUsage();
      const lines = [
        "Session info:",
        `  Model: ${getModel()}`,
        `  Input tokens:  ${usage.inputTokens.toLocaleString()}`,
        `  Output tokens: ${usage.outputTokens.toLocaleString()}`,
        `  CWD: ${process.cwd()}`,
      ];
      return { success: true, output: lines.join("\n") };
    },
  });

  registry.register({
    name: "/exit",
    description: "Exit the REPL",
    aliases: ["/quit"],
    handler: async (ctx) => {
      return { success: true, output: "__EXIT__" };
    },
  });
}
