import { Command } from "commander";

export function createMcpCommand(): Command {
  const cmd = new Command("mcp").description("Manage MCP servers");

  cmd
    .command("list")
    .description("List configured MCP servers")
    .action(async () => {
      const { loadSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      const servers = settings.mcpServers ?? {};
      const entries = Object.entries(servers);
      if (!entries.length) {
        console.log("No MCP servers configured.");
        return;
      }
      for (const [name, config] of entries) {
        const c = config as any;
        console.log(`  ${name}: ${c.command} ${(c.args ?? []).join(" ")}`);
      }
    });

  cmd
    .command("add")
    .description("Add an MCP server")
    .argument("<name>", "Server name")
    .argument("<command>", "Server command")
    .argument("[args...]", "Command arguments")
    .option("-e, --env <pairs...>", "Environment variables (KEY=VALUE)")
    .action(async (name: string, command: string, args: string[], opts: { env?: string[] }) => {
      const { loadSettings, saveSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      settings.mcpServers = settings.mcpServers ?? {};
      const env: Record<string, string> = {};
      if (opts.env) {
        for (const pair of opts.env) {
          const [k, ...v] = pair.split("=");
          if (k) env[k] = v.join("=");
        }
      }
      settings.mcpServers[name] = { command, args, env: Object.keys(env).length ? env : undefined };
      await saveSettings(settings);
      console.log(`Added MCP server: ${name}`);
    });

  cmd
    .command("remove")
    .description("Remove an MCP server")
    .argument("<name>", "Server name")
    .action(async (name: string) => {
      const { loadSettings, saveSettings } = await import("@openharness/core");
      const settings = await loadSettings();
      if (!settings.mcpServers?.[name]) {
        console.error(`MCP server not found: ${name}`);
        process.exit(1);
      }
      delete settings.mcpServers![name];
      await saveSettings(settings);
      console.log(`Removed MCP server: ${name}`);
    });

  return cmd;
}
