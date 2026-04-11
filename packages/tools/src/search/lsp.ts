import type { ToolDefinition } from "@openharness/core";

export const lspTool: ToolDefinition = {
  name: "Lsp",
  description: "Code intelligence: symbols, definitions, references, hover.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["document_symbol", "workspace_symbol", "go_to_definition", "find_references", "hover"], description: "Operation" },
      filePath: { type: "string", description: "Source file path" },
      symbol: { type: "string", description: "Symbol name" },
      line: { type: "number", description: "1-based line number" },
      character: { type: "number", description: "1-based character offset" },
      query: { type: "string", description: "Query for workspace_symbol" },
    },
    required: ["operation"],
  },
  async execute(input, context) {
    const { LspClient } = await import("@openharness/services");
    const operation = input.operation as string;
    const client = new LspClient({ command: "", args: [] });

    if (operation === "workspace_symbol") {
      const results = await client.workspaceSymbolSearch(context.cwd, (input.query as string) ?? "");
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    const filePath = input.filePath as string;
    if (!filePath) return { content: [{ type: "text", text: `${operation} requires filePath` }], isError: true };

    const { resolve } = await import("node:path");
    const fullPath = resolve(context.cwd, filePath);

    if (operation === "document_symbol") {
      const results = await client.documentSymbols(fullPath);
      if (!results.length) return { content: [{ type: "text", text: "(no symbols)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "go_to_definition") {
      const results = await client.goToDefinition(context.cwd, fullPath, input.symbol as string, input.line as number | undefined);
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.kind} ${r.name} - ${r.path}:${r.line}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "find_references") {
      const results = await client.findReferences(context.cwd, fullPath, input.symbol as string, input.line as number | undefined);
      if (!results.length) return { content: [{ type: "text", text: "(no results)" }] };
      const text = results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (operation === "hover") {
      const result = await client.hover(context.cwd, fullPath, input.symbol as string, input.line as number, input.character as number);
      if (!result) return { content: [{ type: "text", text: "(no hover result)" }] };
      const parts = [`${result.kind} ${result.name}`, `${result.path}:${result.line}:${result.character}`];
      if (result.signature) parts.push(`signature: ${result.signature}`);
      return { content: [{ type: "text", text: parts.join("\n") }] };
    }

    return { content: [{ type: "text", text: `Unknown operation: ${operation}` }], isError: true };
  },
};
