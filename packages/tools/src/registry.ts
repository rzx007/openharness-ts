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
import { imageGenerationTool, imageToTextTool } from "./media/index.js";
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
import { contextMemoryTools } from "./context/index.js";

export function createDefaultToolRegistry(
  options: {
    schedules?: boolean;
    terminal?: boolean;
    jobs?: boolean;
    imageToText?: boolean;
    contextMemory?: boolean;
    agentDefinitions?: AgentDefinition[];
    workflowRepository?: WorkflowRunRepository;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(fileReadTool);
  registry.register(fileWriteTool);
  registry.register(fileEditTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(webFetchTool);
  registry.register(webSearchTool);
  registry.register(todoWriteTool);
  registry.register(configTool);
  registry.register(sleepTool);
  registry.register(skillTool);
  registry.register(listSkillsTool);
  registry.register(toolSearchTool);
  registry.register(askUserTool);
  registry.register(briefTool);
  registry.register(backgroundShellCreateTool);
  registry.register(enterPlanModeTool);
  registry.register(exitPlanModeTool);
  registry.register(enterWorktreeTool);
  registry.register(exitWorktreeTool);
  registry.register(notebookEditTool);
  registry.register(
    options.agentDefinitions === undefined
      ? agentTool
      : createAgentTool({ agentDefinitions: options.agentDefinitions }),
  );
  if (options.workflowRepository) {
    registry.register(createWorkflowTool({ repository: options.workflowRepository }));
  }
  registry.register(teamCreateTool);
  registry.register(teamDeleteTool);
  if (options.schedules) {
    registry.register(scheduleCreateTool);
    registry.register(scheduleUpdateTool);
    registry.register(scheduleDeleteTool);
    registry.register(scheduleListTool);
    registry.register(scheduleRunNowTool);
  }
  if (options.terminal) {
    for (const tool of terminalTools) registry.register(tool);
  }
  if (options.jobs) {
    for (const tool of jobTools) registry.register(tool);
  }
  registry.register(mcpToolCallTool);
  registry.register(listMcpResourcesTool);
  registry.register(readMcpResourceTool);
  registry.register(mcpAuthTool);
  registry.register(lspTool);
  if (options.imageToText) registry.register(imageToTextTool);
  registry.register(imageGenerationTool);
  registry.register(feishuPushTool);
  if (options.contextMemory) {
    for (const tool of contextMemoryTools) registry.register(tool);
  }
  return registry;
}
