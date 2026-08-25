import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OpenHarnessClient } from "@openharness/client";
import { requestedPluginPermissions, validateNativePlugin } from "@openharness/plugins";
import { createBuiltinConverterRegistry } from "@openharness/plugin-converters";
import { Command, Option } from "commander";
import { ensureLocalDaemon } from "../ensure-daemon.js";

async function client(): Promise<OpenHarnessClient> {
  const daemon = await ensureLocalDaemon();
  return new OpenHarnessClient({ baseUrl: daemon.url, token: daemon.token });
}
const collect = (value: string, previous: string[]) => [...previous, value];

export function createPluginCommand(): Command {
  const cmd = new Command("plugin").description("Manage Native Plugins");
  cmd.command("list").option("--cwd <path>").action(async (options) => {
    const result = await (await client()).listPlugins({ cwd: resolve(options.cwd ?? process.cwd()) });
    if (!result.plugins.length) return console.log("No Native Plugins installed.");
    for (const plugin of result.plugins) console.log(`${plugin.identity.id}@${plugin.identity.version} ${plugin.scope} ${plugin.enabled ? "enabled" : "disabled"} ${plugin.activation}`);
  });
  cmd.command("validate").argument("<path>").action(async (path) => {
    const result = await validateNativePlugin(resolve(path));
    if (result.status === "valid") console.log(`Valid Native Plugin: ${result.plugin!.manifest.id}@${result.plugin!.manifest.version}`);
    else { for (const item of result.diagnostics) console.error(`${item.code}: ${item.message}`); process.exitCode = 1; }
  });
  for (const [name, link] of [["install-local", false], ["link", true]] as const) {
    cmd.command(name).argument("<path>")
      .addOption(new Option("--scope <scope>").choices(["user", "project", "local"]).default("user"))
      .option("--cwd <path>").option("--approve <permission>", "approve a requested permission", collect, [])
      .action(async (path, options) => {
        const sourcePath = resolve(path);
        const validation = await validateNativePlugin(sourcePath);
        if (!validation.plugin) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
        const requested = requestedPluginPermissions(validation.plugin.manifest);
        const approved = options.approve as string[];
        const missing = requested.filter((item) => !approved.includes(item));
        if (missing.length) throw new Error(`Explicit approval required: ${missing.join(", ")}`);
        const result = await (await client()).installLocalPlugin({
          cwd: resolve(options.cwd ?? process.cwd()), sourcePath, scope: options.scope,
          approvedPermissions: approved, link,
        });
        console.log(result.message);
      });
  }
  for (const action of ["enable", "disable"] as const) cmd.command(action).argument("<id>").option("--cwd <path>").action(async (id, options) => {
    const api = await client(); const input = { cwd: resolve(options.cwd ?? process.cwd()) };
    console.log((action === "enable" ? await api.enablePlugin(id, input) : await api.disablePlugin(id, input)).message);
  });
  cmd.command("uninstall").argument("<id>").option("--cwd <path>").action(async (id, options) => {
    console.log((await (await client()).uninstallPlugin(id, { cwd: resolve(options.cwd ?? process.cwd()) })).message);
  });
  cmd.command("details").argument("<id>").option("--cwd <path>").action(async (id, options) => {
    const listed = await (await client()).listPlugins({ cwd: resolve(options.cwd ?? process.cwd()) });
    const plugin = listed.plugins.find((item) => item.identity.id === id);
    if (!plugin) throw new Error(`Plugin not found: ${id}`);
    console.log(JSON.stringify(plugin, null, 2));
  });
  cmd.command("install").argument("<source>").requiredOption("--from <converter>")
    .addOption(new Option("--scope <scope>").choices(["user", "project", "local"]).default("user"))
    .option("--cwd <path>").option("--approve <item>", "approve conversion item or permission", collect, [])
    .action(async (source, options) => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "ohs-plugin-import-"));
      const output = join(temporaryRoot, "native");
      try {
        const { converter } = await createBuiltinConverterRegistry().detect(resolve(source), options.from);
        const inspection = await converter.inspect(resolve(source));
        const plan = await converter.plan(inspection, {});
        await converter.convert({ inspection, plan, output, approvals: options.approve });
        const validation = await validateNativePlugin(output);
        if (!validation.plugin) throw new Error(validation.diagnostics.map((item) => item.message).join("; "));
        const requested = requestedPluginPermissions(validation.plugin.manifest);
        const missing = requested.filter((item) => !(options.approve as string[]).includes(item));
        if (missing.length) throw new Error(`Explicit permission approval required: ${missing.join(", ")}`);
        const result = await (await client()).installLocalPlugin({
          cwd: resolve(options.cwd ?? process.cwd()), sourcePath: output, scope: options.scope,
          approvedPermissions: requested,
        });
        console.log(result.message);
      } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
    });
  cmd.command("convert").argument("<source>")
    .option("--from <converter>").option("--output <path>").option("--dry-run").option("--json")
    .option("--approve <item>", "approve a blocked conversion item", collect, [])
    .action(async (source, options) => {
      const registry = createBuiltinConverterRegistry();
      const { converter, detection } = await registry.detect(resolve(source), options.from);
      const inspection = await converter.inspect(resolve(source));
      const plan = await converter.plan(inspection, {});
      if (options.dryRun) {
        console.log(options.json ? JSON.stringify({ detection, inspection, plan }, null, 2) : plan.items.map((item) => `${item.fidelity.padEnd(11)} ${item.id}`).join("\n"));
        return;
      }
      if (!options.output) throw new Error("--output is required unless --dry-run is used");
      const report = await converter.convert({ inspection, plan, output: resolve(options.output), approvals: options.approve });
      console.log(options.json ? JSON.stringify(report, null, 2) : `Converted ${inspection.identity.id}: ${report.status}`);
    });
  return cmd;
}
