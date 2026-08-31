import type {
  AgentContextMemoryCallContext,
  AgentContextMemoryHost,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@openharness/core";

type HostMethod = keyof Pick<AgentContextMemoryHost, "remember" | "recall" | "resolve" | "update" | "forget">;

export const contextMemoryTools: ToolDefinition[] = [
  createContextTool(
    "ContextRemember",
    "Remember one or more durable user preferences, project rules, project knowledge, or environment facts through the governed context service.",
    "remember",
    { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
  ),
  createContextTool(
    "ContextRecall",
    "Recall governed persistent context relevant to the current user and project.",
    "recall",
    { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
  ),
  createContextTool(
    "ContextResolve",
    "Accept or reject a pending context decision by logical entry ID.",
    "resolve",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["accept", "reject"] },
        topic: { type: "string" },
      },
      required: ["id", "action"],
      additionalProperties: false,
    },
  ),
  createContextTool(
    "ContextUpdate",
    "Update a governed context entry by logical ID. Never edit its backing file.",
    "update",
    {
      type: "object",
      properties: { id: { type: "string" }, content: { type: "string" } },
      required: ["id", "content"],
      additionalProperties: false,
    },
  ),
  createContextTool(
    "ContextForget",
    "Forget a governed context entry by logical ID.",
    "forget",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  ),
];

function createContextTool(
  name: string,
  description: string,
  method: HostMethod,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    execute: async (input, toolContext) => executeHost(method, input, toolContext),
  };
}

async function executeHost(
  method: HostMethod,
  input: Record<string, unknown>,
  toolContext: ToolContext,
): Promise<ToolResult> {
  const host = toolContext.contextMemory;
  const scope = toolContext.agent?.scope;
  if (!host || !scope) {
    return {
      content: [{ type: "text", text: "Persistent context is not available in this runtime." }],
      isError: true,
      failureKind: "policy",
    };
  }
  const context: AgentContextMemoryCallContext = {
    sessionId: scope.sessionId,
    runId: scope.runId,
    inputId: scope.inputId,
    cwd: scope.cwd,
    signal: toolContext.abortSignal ?? scope.signal,
  };
  const result = await (host[method] as (value: never, context: AgentContextMemoryCallContext) => Promise<unknown>)(
    input as never,
    context,
  );
  const safeResult = omitStorageLocations(result);
  return {
    content: [{ type: "text", text: JSON.stringify(safeResult) }],
    metadata: { contextResult: safeResult },
  };
}

function omitStorageLocations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitStorageLocations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, nested]) =>
    /^(?:path|directory|filePath|root)$/iu.test(key) ? [] : [[key, omitStorageLocations(nested)]],
  ));
}
