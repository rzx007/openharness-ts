import { COORDINATOR_SYSTEM_PROMPT, isCoordinatorMode } from "./index.js";

/**
 * Coordinator 模式辅助（移植自 Python coordinator_mode.py 的 mode/上下文段）。
 *
 * 工具名用 TS 侧命名（Agent/SendMessage/TaskStop 等 PascalCase），
 * 其余语义与 Python 一致。
 */

/** worker 可用工具全集（TS 工具名，对齐 Python _WORKER_TOOLS 语义）。 */
const WORKER_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "Skill",
] as const;

const SIMPLE_WORKER_TOOLS = ["Bash", "Read", "Edit"] as const;

const TRUTHY = new Set(["1", "true", "yes"]);

/** CLAUDE_CODE_SIMPLE：worker 只配最小工具集的「简单模式」。 */
export function isSimpleMode(): boolean {
  return TRUTHY.has((process.env.CLAUDE_CODE_SIMPLE ?? "").toLowerCase());
}

/**
 * 恢复会话时把 env 的 coordinator 开关对齐到会话存储的 mode。
 * 发生切换时返回提示文案，未变化返回 undefined。
 */
export function matchSessionMode(sessionMode?: string): string | undefined {
  if (!sessionMode) return undefined;

  const currentIsCoordinator = isCoordinatorMode();
  const sessionIsCoordinator = sessionMode === "coordinator";
  if (currentIsCoordinator === sessionIsCoordinator) return undefined;

  if (sessionIsCoordinator) {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "1";
    return "Entered coordinator mode to match resumed session.";
  }
  delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
  return "Exited coordinator mode to match resumed session.";
}

/** coordinator 专属工具集。 */
export function getCoordinatorTools(): string[] {
  return ["Agent", "SendMessage", "TaskStop"];
}

/**
 * 注入 coordinator 用户轮的 workerToolsContext：worker 工具清单 +
 * 可用 MCP server + scratchpad 目录说明。非 coordinator 模式返回 {}。
 */
export function getCoordinatorUserContext(
  mcpClients?: Array<{ name: string }>,
  scratchpadDir?: string,
): Record<string, string> {
  if (!isCoordinatorMode()) return {};

  const tools = [...(isSimpleMode() ? SIMPLE_WORKER_TOOLS : WORKER_TOOLS)].sort();
  let content = `Workers spawned via the Agent tool have access to these tools: ${tools.join(", ")}`;

  if (mcpClients && mcpClients.length > 0) {
    const serverNames = mcpClients.map((c) => c.name).join(", ");
    content += `\n\nWorkers also have access to MCP tools from connected MCP servers: ${serverNames}`;
  }

  if (scratchpadDir) {
    content +=
      `\n\nScratchpad directory: ${scratchpadDir}\n` +
      "Workers can read and write here without permission prompts. " +
      "Use this for durable cross-worker knowledge — structure files however fits the work.";
  }

  return { workerToolsContext: content };
}

const RICH_CAPABILITIES =
  "Workers have access to standard tools, MCP tools from configured MCP servers, " +
  "and project skills via the Skill tool. Delegate skill invocations (e.g. /commit, /verify) to workers.";

const SIMPLE_CAPABILITIES =
  "Workers have access to Bash, Read, and Edit tools, plus MCP tools from configured MCP servers.";

/**
 * coordinator system prompt：静态常量是富版本；简单模式把 §3 的能力句换成
 * 最小工具集版（对齐 Python get_coordinator_system_prompt 的 is_simple 分支）。
 */
export function getCoordinatorSystemPrompt(): string {
  if (!isSimpleMode()) return COORDINATOR_SYSTEM_PROMPT;
  return COORDINATOR_SYSTEM_PROMPT.replace(RICH_CAPABILITIES, SIMPLE_CAPABILITIES);
}
