import { Command } from "commander";

export function createPluginCommand(): Command {
  const cmd = new Command("plugin").description("Manage plugins");

  cmd
    .command("list")
    .description("List installed plugins")
    .action(async () => {
      const { listInstalled } = await import("@openharness/plugins");
      const plugins = await listInstalled();
      if (!plugins.length) {
        console.log("No plugins installed.");
        return;
      }
      for (const p of plugins) {
        console.log(`  ${p.name} v${p.version ?? "?"}${p.enabled ? "" : " (disabled)"}`);
      }
    });

  cmd
    .command("install")
    .description("Install a plugin")
    .argument("<source>", "Plugin path or npm package")
    .action(async (source: string) => {
      const { installPlugin } = await import("@openharness/plugins");
      try {
        await installPlugin(source);
        console.log(`Installed plugin: ${source}`);
      } catch (err: any) {
        console.error(`Failed to install: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("uninstall")
    .description("Uninstall a plugin")
    .argument("<name>", "Plugin name")
    .action(async (name: string) => {
      const { uninstallPlugin } = await import("@openharness/plugins");
      try {
        await uninstallPlugin(name);
        console.log(`Uninstalled plugin: ${name}`);
      } catch (err: any) {
        console.error(`Failed to uninstall: ${err.message}`);
        process.exit(1);
      }
    });

  return cmd;
}
