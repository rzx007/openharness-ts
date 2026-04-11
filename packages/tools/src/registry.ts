import { ToolRegistry } from "@openharness/core";
import { bashTool } from "./shell/bash";
import { fileReadTool } from "./file/read";
import { fileWriteTool } from "./file/write";
import { fileEditTool } from "./file/edit";
import { globTool } from "./file/glob";
import { grepTool } from "./search/grep";
import { webFetchTool } from "./web/fetch";
import { webSearchTool } from "./web/search";
import { todoWriteTool } from "./meta/todo-write";
import { configTool } from "./meta/config";
import { sleepTool } from "./meta/sleep";
import { skillTool } from "./meta/skill";
import { toolSearchTool } from "./meta/tool-search";
import { askUserTool } from "./meta/ask-user";
import { briefTool } from "./meta/brief";

export function createDefaultToolRegistry(): ToolRegistry {
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
  return registry;
}
