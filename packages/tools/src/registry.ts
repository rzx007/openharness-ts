import { ToolRegistry } from "@openharness/core";
import {
  agentTool,
  createAgentTool,
  teamCreateTool,
  teamDeleteTool,
  createWorkflowTool,
} from "./agent/index.js";
import type { AgentDefinition, WorkflowRunRepository } from "@openharness/coordinator";
import { feishuPushTool } from "./channels/index.js";
import {
  fileEditTool,
  fileReadTool,
  fileWriteTool,
  globTool,
} from "./file/index.js";
import {
  askUserTool,
  briefTool,
  configTool,
  listSkillsTool,
  skillTool,
  sleepTool,
  todoWriteTool,
  toolSearchTool,
} from "./meta/index.js";
import {
  enterPlanModeTool,
  enterWorktreeTool,
  exitPlanModeTool,
  exitWorktreeTool,
} from "./mode/index.js";
import {
  listMcpResourcesTool,
  mcpAuthTool,
  mcpToolCallTool,
  readMcpResourceTool,
} from "./mcp/index.js";
import { notebookEditTool } from "./notebook/index.js";
import {
  scheduleCreateTool,
  scheduleDeleteTool,
  scheduleListTool,
  scheduleRunNowTool,
  scheduleUpdateTool,
} from "./schedule/index.js";
import { grepTool, lspTool } from "./search/index.js";
import { bashTool } from "./shell/index.js";
import { backgroundShellCreateTool } from "./background-shell/index.js";
import { webFetchTool, webSearchTool } from "./web/index.js";
import { terminalTools } from "./terminal/index.js";
import { jobTools } from "./job/index.js";

export function createDefaultToolRegistry(
  options: {
    schedules?: boolean;
    terminal?: boolean;
    jobs?: boolean;
    backgroundShell?: boolean;
    childEnvironment?: boolean;
    agentDefinitions?: AgentDefinition[];
    workflowRepository?: WorkflowRunRepository;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const registerBuiltin = (tool: Parameters<ToolRegistry["register"]>[0]) =>
    registry.register(tool, { kind: "builtin" });
  registerBuiltin(bashTool);
  registerBuiltin(fileReadTool);
  registerBuiltin(fileWriteTool);
  registerBuiltin(fileEditTool);
  registerBuiltin(globTool);
  registerBuiltin(grepTool);
  registerBuiltin(webFetchTool);
  registerBuiltin(webSearchTool);
  registerBuiltin(todoWriteTool);
  registerBuiltin(configTool);
  registerBuiltin(sleepTool);
  registerBuiltin(skillTool);
  registerBuiltin(listSkillsTool);
  registerBuiltin(toolSearchTool);
  registerBuiltin(askUserTool);
  registerBuiltin(briefTool);
  if (options.backgroundShell !== false) {
    registerBuiltin(backgroundShellCreateTool);
  }
  registerBuiltin(enterPlanModeTool);
  registerBuiltin(exitPlanModeTool);
  registerBuiltin(enterWorktreeTool);
  registerBuiltin(exitWorktreeTool);
  registerBuiltin(notebookEditTool);
  if (options.childEnvironment !== false) {
    registerBuiltin(
      options.agentDefinitions === undefined
        ? agentTool
        : createAgentTool({ agentDefinitions: options.agentDefinitions }),
    );
  }
  if (options.workflowRepository) {
    registerBuiltin(createWorkflowTool({ repository: options.workflowRepository }));
  }
  registerBuiltin(teamCreateTool);
  registerBuiltin(teamDeleteTool);
  if (options.schedules) {
    registerBuiltin(scheduleCreateTool);
    registerBuiltin(scheduleUpdateTool);
    registerBuiltin(scheduleDeleteTool);
    registerBuiltin(scheduleListTool);
    registerBuiltin(scheduleRunNowTool);
  }
  if (options.terminal) {
    for (const tool of terminalTools) registerBuiltin(tool);
  }
  if (options.jobs) {
    for (const tool of jobTools) registerBuiltin(tool);
  }
  registerBuiltin(mcpToolCallTool);
  registerBuiltin(listMcpResourcesTool);
  registerBuiltin(readMcpResourceTool);
  registerBuiltin(mcpAuthTool);
  registerBuiltin(lspTool);
  registerBuiltin(feishuPushTool);
  return registry;
}
