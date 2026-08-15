import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@openharness/core";
import type { TerminalSignal } from "@openharness/terminal";

const terminalIdProperty = {
  type: "string",
  description: "Terminal id returned by TerminalOpen or TerminalList",
};

export const terminalOpenTool: ToolDefinition = {
  name: "TerminalOpen",
  description:
    "Open a persistent interactive terminal in this session's working directory. Prefer Bash for a single non-interactive command; use this for long-running or interactive processes.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short label shown in the terminal panel",
      },
      cols: {
        type: "number",
        description: "Initial terminal columns",
        default: 100,
      },
      rows: {
        type: "number",
        description: "Initial terminal rows",
        default: 30,
      },
      shell: { type: "string", description: "Optional shell executable" },
    },
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminal = await resolved.host.open({
        sessionId: resolved.sessionId,
        cwd: context.cwd,
        name: optionalString(input.name),
        cols: optionalNumber(input.cols),
        rows: optionalNumber(input.rows),
        shell: optionalString(input.shell),
      });
      return terminalResult("open", { terminal });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalSendTool: ToolDefinition = {
  name: "TerminalSend",
  description:
    "Send text or control characters to a persistent terminal. Include a newline when the command should be submitted; newline characters are normalized to the terminal Enter key unless raw is true.",
  inputSchema: {
    type: "object",
    properties: {
      terminalId: terminalIdProperty,
      data: {
        type: "string",
        description: "Input text, for example `npm run dev\n`",
      },
      raw: {
        type: "boolean",
        description:
          "When true, send data exactly as provided without newline normalization.",
      },
    },
    required: ["terminalId", "data"],
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminalId = requiredString(input.terminalId, "terminalId");
      const data =
        typeof input.data === "string"
          ? prepareTerminalInput(input.data, { raw: input.raw === true })
          : "";
      await resolved.host.send({
        sessionId: resolved.sessionId,
        terminalId,
        data,
      });
      return terminalResult("send", { terminalId, bytes: data.length });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalReadTool: ToolDefinition = {
  name: "TerminalRead",
  description:
    "Read the latest retained output and status from a persistent terminal.",
  inputSchema: {
    type: "object",
    properties: { terminalId: terminalIdProperty },
    required: ["terminalId"],
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminalId = requiredString(input.terminalId, "terminalId");
      const snapshot = await resolved.host.read({
        sessionId: resolved.sessionId,
        terminalId,
      });
      const maxChars = 12_000;
      const output =
        snapshot.data.length > maxChars
          ? snapshot.data.slice(-maxChars)
          : snapshot.data;
      return terminalResult("read", {
        terminalId,
        output,
        sequence: snapshot.sequence,
        truncated: snapshot.truncated || output.length < snapshot.data.length,
      });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalSignalTool: ToolDefinition = {
  name: "TerminalSignal",
  description:
    "Send interrupt (Ctrl+C), end-of-file (Ctrl+D), or terminate to a persistent terminal.",
  inputSchema: {
    type: "object",
    properties: {
      terminalId: terminalIdProperty,
      signal: { type: "string", enum: ["interrupt", "eof", "terminate"] },
    },
    required: ["terminalId", "signal"],
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminalId = requiredString(input.terminalId, "terminalId");
      const signal = readSignal(input.signal);
      await resolved.host.signal({
        sessionId: resolved.sessionId,
        terminalId,
        signal,
      });
      return terminalResult("signal", { terminalId, signal });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalCloseTool: ToolDefinition = {
  name: "TerminalClose",
  description:
    "Terminate and remove a persistent terminal owned by this Agent session.",
  inputSchema: {
    type: "object",
    properties: { terminalId: terminalIdProperty },
    required: ["terminalId"],
  },
  async execute(input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      const terminalId = requiredString(input.terminalId, "terminalId");
      await resolved.host.close({ sessionId: resolved.sessionId, terminalId });
      return terminalResult("close", { terminalId });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalListTool: ToolDefinition = {
  name: "TerminalList",
  description: "List persistent terminals owned by this Agent session.",
  inputSchema: { type: "object", properties: {} },
  async execute(_input, context) {
    const resolved = resolveHost(context);
    if ("content" in resolved) return resolved;
    try {
      return terminalResult("list", {
        terminals: await resolved.host.list(resolved.sessionId),
      });
    } catch (error) {
      return failed(error);
    }
  },
};

export const terminalTools = [
  terminalOpenTool,
  terminalSendTool,
  terminalReadTool,
  terminalSignalTool,
  terminalCloseTool,
  terminalListTool,
];

function resolveHost(
  context: ToolContext,
):
  | { host: NonNullable<ToolContext["terminal"]>; sessionId: string }
  | ToolResult {
  if (!context.terminal)
    return failed("This host does not provide persistent terminals.");
  if (!context.sessionId)
    return failed("Persistent terminals require a durable session.");
  return { host: context.terminal, sessionId: context.sessionId };
}

function terminalResult(
  action: string,
  value: Record<string, unknown>,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ kind: "terminal", action, ...value }),
      },
    ],
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function prepareTerminalInput(
  data: string,
  options: { raw: boolean },
): string {
  if (options.raw) return data;
  return data.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
}

function readSignal(value: unknown): TerminalSignal {
  if (value === "interrupt" || value === "eof" || value === "terminate")
    return value;
  throw new Error("signal must be interrupt, eof, or terminate.");
}

function failed(error: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}
