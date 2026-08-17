import { ToolRegistry } from "@openharness/core";
import {
  agentTool,
  teamCreateTool,
  teamDeleteTool,
  workflowTool,
} from "./agent/index.js";
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
  cronCreateTool,
  cronDeleteTool,
  cronListTool,
  cronToggleTool,
  remoteTriggerTool,
} from "./schedule/index.js";
import { grepTool, lspTool } from "./search/index.js";
import { bashTool } from "./shell/index.js";
import { taskCreateTool } from "./task/index.js";
import { webFetchTool, webSearchTool } from "./web/index.js";
import { terminalTools } from "./terminal/index.js";
import { jobTools } from "./job/index.js";

export function createDefaultToolRegistry(
  options: { cron?: boolean; terminal?: boolean; jobs?: boolean } = {},
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
  registry.register(toolSearchTool);
  registry.register(askUserTool);
  registry.register(briefTool);
  registry.register(taskCreateTool);
  registry.register(enterPlanModeTool);
  registry.register(exitPlanModeTool);
  registry.register(enterWorktreeTool);
  registry.register(exitWorktreeTool);
  registry.register(notebookEditTool);
  registry.register(agentTool);
  registry.register(workflowTool);
  registry.register(teamCreateTool);
  registry.register(teamDeleteTool);
  if (options.cron) {
    registry.register(cronCreateTool);
    registry.register(cronDeleteTool);
    registry.register(cronListTool);
    registry.register(cronToggleTool);
    registry.register(remoteTriggerTool);
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
  registry.register(imageToTextTool);
  registry.register(imageGenerationTool);
  registry.register(feishuPushTool);
  return registry;
}
