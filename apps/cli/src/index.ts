import { Command } from "commander";
import { mainAction } from "./commands/main";
import { createAuthCommand } from "./commands/auth";
import { createMcpCommand } from "./commands/mcp";
import { createPluginCommand } from "./commands/plugin";
import { createCronCommand } from "./commands/cron";

const program = new Command();

program
  .name("oh")
  .description("OpenHarness - Open Source AI Agent Framework")
  .version("0.1.0")
  .argument("[prompt]", "Initial prompt to send")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --print", "Print response and exit (non-interactive)")
  .option("-c, --continue", "Continue last session")
  .option("-r, --resume <session>", "Resume a specific session")
  .option("-n, --name <name>", "Name the session")
  .option("--provider <provider>", "API provider")
  .option("--permission-mode <mode>", "Permission mode (default | plan | acceptEdits | bypassPermissions | dontAsk)")
  .option("--max-turns <n>", "Maximum agentic turns", parseInt)
  .option("-s, --system-prompt <prompt>", "Override system prompt")
  .option("--api-key <key>", "API key override")
  .option("--base-url <url>", "API base URL override")
  .option("--api-format <format>", "API format (anthropic | openai)")
  .option("--theme <theme>", "Theme name")
  .option("--mcp-config <path>", "Path to MCP config JSON")
  .option("--cwd <dir>", "Working directory")
  .option("--effort <level>", "Effort level (low | medium | high)")
  .option("--verbose", "Verbose output")
  .option("-d, --debug", "Debug mode")
  .option("--backend-only", "Run as backend host for TUI")
  .option("--tui", "Launch terminal UI (React/Ink frontend)")
  .option("--dangerously-skip-permissions", "Skip all permission checks")
  .option("--allowed-tools <tools>", "Comma-separated allowed tools")
  .option("--disallowed-tools <tools>", "Comma-separated disallowed tools")
  .option("--output-format <format>", "Output format (text | json | stream-json)")
  .option("--append-system-prompt <prompt>", "Append to default system prompt")
  .option("--bare", "Skip hooks/plugins/MCP loading")
  .action(mainAction);

program.addCommand(createAuthCommand());
program.addCommand(createMcpCommand());
program.addCommand(createPluginCommand());
program.addCommand(createCronCommand());

program
  .command("config")
  .description("Show or edit configuration")
  .argument("[action]", "show or set", "show")
  .argument("[key]", "Config key")
  .argument("[value]", "Config value")
  .action(async (action: string, key?: string, value?: string) => {
    const { loadSettings, saveSettings } = await import("@openharness/core");
    const settings = await loadSettings();
    if (action === "show" || !key) {
      console.log(JSON.stringify(settings, null, 2));
    } else if (action === "set" && key && value !== undefined) {
      if (!(key in settings)) {
        console.error(`Unknown config key: ${key}`);
        process.exit(1);
      }
      (settings as any)[key] = value;
      await saveSettings(settings);
      console.log(`Updated ${key}`);
    } else {
      console.error("Usage: oh config show | oh config set <key> <value>");
      process.exit(1);
    }
  });

program
  .command("version")
  .description("Show version information")
  .action(() => {
    console.log("OpenHarness v0.1.0");
    console.log(`Node ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
  });

program
  .command("doctor")
  .description("Check environment and dependencies")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    console.log(chalk.cyan("OpenHarness Doctor"));
    console.log();
    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

    try {
      const { loadSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      checks.push({ label: "Settings loaded", ok: true, detail: `model: ${settings.model}` });
    } catch (err: any) {
      checks.push({ label: "Settings loaded", ok: false, detail: err.message });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
    checks.push({ label: "API key", ok: !!apiKey, detail: apiKey ? "found" : "not set" });

    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const claudeMd = join(process.cwd(), "CLAUDE.md");
      await readFile(claudeMd, "utf-8");
      checks.push({ label: "CLAUDE.md", ok: true, detail: "found in cwd" });
    } catch {
      checks.push({ label: "CLAUDE.md", ok: false, detail: "not found in cwd" });
    }

    for (const c of checks) {
      const icon = c.ok ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${c.label}${c.detail ? chalk.gray(` (${c.detail})`) : ""}`);
    }
  });

program.parse();
