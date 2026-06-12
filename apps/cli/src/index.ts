import { Command } from "commander";
import { mainAction } from "./commands/main";
import { createAuthCommand } from "./commands/auth";
import { createMcpCommand } from "./commands/mcp";
import { createPluginCommand } from "./commands/plugin";
import { createCronCommand } from "./commands/cron";
import { createChannelsCommand } from "./commands/channels";
import { createProviderCommand } from "./commands/provider";
import { createSetupCommand } from "./commands/setup";
import { VERSION } from "./version";

const program = new Command();

program
  .name("ohs")
  .description("OpenHarness-ts - Open Source AI Agent Framework")
  .version(VERSION)
  .argument("[prompt]", "Initial prompt to send")
  .option("-m, --model <model>", "Model to use")
  .option("-p, --print", "Print response and exit (non-interactive)")
  .option("-c, --continue", "Continue last session")
  .option("-r, --resume <session>", "Resume a specific session")
  .option("-n, --name <name>", "Name the session")
  .option("--provider <provider>", "API provider")
  .option("--permission-mode <mode>", "Permission mode (default | plan | full_auto)")
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
  .option("--backend-only", "Run as BackendHost for TUI (spawned by TUI frontend; OHJSON on stdin/stdout)")
  .option("--tui", "Launch terminal UI (opentui frontend, requires Bun)")
  .option("--dangerously-skip-permissions", "Skip all permission checks")
  .option("--allowed-tools <tools>", "Comma-separated allowed tools")
  .option("--disallowed-tools <tools>", "Comma-separated disallowed tools")
  .option("--output-format <format>", "Output format (text | json | stream-json)")
  .option("--append-system-prompt <prompt>", "Append to default system prompt")
  .option("--bare", "Skip hooks/plugins/MCP loading")
  .option("--dry-run", "预览解析后的运行时配置，不调用模型")
  .option("--swarm-worker", "以 swarm worker 身份运行：只读工具自动放行（内部用）")
  .option("--task-worker", "stdin 驱动的无 TTY worker:读一行跑一轮即退(内部用,teammate 多轮)")
  .action(mainAction);

program.addCommand(createAuthCommand());
program.addCommand(createMcpCommand());
program.addCommand(createPluginCommand());
program.addCommand(createCronCommand());
program.addCommand(createChannelsCommand());
program.addCommand(createProviderCommand());
program.addCommand(createSetupCommand());

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
    console.log(`OpenHarness v${VERSION}`);
    console.log(`Node ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
  });

program
  .command("doctor")
  .description("Check environment and dependencies")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    console.log(chalk.cyan("OpenHarness-ts Doctor"));
    console.log();
    const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];

    let settings: import("@openharness/core").Settings | undefined;
    try {
      const { loadSettings } = await import("@openharness/core");
      settings = await loadSettings();
      checks.push({
        label: "Settings loaded",
        ok: true,
        detail: `provider: ${settings.provider ?? "auto"}, model: ${settings.model}`,
      });
    } catch (err: any) {
      checks.push({ label: "Settings loaded", ok: false, detail: err.message });
    }

    if (settings) {
      const { checkApiKey } = await import("./doctor");
      const keyCheck = await checkApiKey(settings);
      checks.push({ label: "API key", ok: keyCheck.ok, detail: keyCheck.source });
    } else {
      checks.push({ label: "API key", ok: false, detail: "settings not loaded" });
    }

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
