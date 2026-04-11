#!/usr/bin/env node

import { Command } from "commander";
import { mainAction } from "./commands/main";

const program = new Command();

program
  .name("oh")
  .description("OpenHarness - Open Source AI Agent Framework")
  .version("0.1.0")
  .argument("[prompt]", "Initial prompt to send")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --print", "Print response and exit (non-interactive)")
  .option("--continue", "Continue last session")
  .option("--resume <session>", "Resume a specific session")
  .option("--provider <provider>", "API provider (anthropic | openai | copilot)")
  .option("--permission-mode <mode>", "Permission mode (default | plan | full_auto)")
  .option("--backend-only", "Run as backend host for TUI")
  .action(mainAction);

program
  .command("auth")
  .description("Manage authentication")
  .action(() => console.log("Auth management not yet implemented"));

program
  .command("mcp")
  .description("Manage MCP servers")
  .action(() => console.log("MCP management not yet implemented"));

program
  .command("plugin")
  .description("Manage plugins")
  .action(() => console.log("Plugin management not yet implemented"));

program
  .command("cron")
  .description("Manage cron jobs")
  .action(() => console.log("Cron management not yet implemented"));

program.parse();
