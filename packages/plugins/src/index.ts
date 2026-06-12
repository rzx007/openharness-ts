export {
  PluginManifestSchema,
  findManifest,
  getUserPluginsDir,
  getProjectPluginsDir,
  discoverPluginPaths,
  loadPlugin,
  loadPlugins,
  type PluginManifest,
  type LoadedPlugin,
  type PluginDiscoverySettings,
} from "./discovery.js";

import { readdir, stat, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 插件安装器（最小版）：`oh plugin install/uninstall/list` 子命令的后端。
 * R3 将补卸载路径穿越防护。
 */
export class PluginInstaller {
  private installDir: string;

  constructor(installDir: string) {
    this.installDir = installDir;
  }

  async install(source: string): Promise<string> {
    const name = source.split("/").pop() ?? source;
    const target = join(this.installDir, name);
    await mkdir(target, { recursive: true });
    const manifest = { name, version: "1.0.0" };
    await writeFile(join(target, "plugin.json"), JSON.stringify(manifest, null, 2));
    return target;
  }

  async uninstall(name: string): Promise<boolean> {
    const target = join(this.installDir, name);
    try {
      await stat(target);
      await rm(target, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async listInstalled(): Promise<string[]> {
    try {
      const entries = await readdir(this.installDir);
      const result: string[] = [];
      for (const entry of entries) {
        const full = join(this.installDir, entry);
        const s = await stat(full);
        if (s.isDirectory()) result.push(entry);
      }
      return result;
    } catch {
      return [];
    }
  }
}

async function getInstaller(): Promise<PluginInstaller> {
  const { getPluginsDir } = await import("@openharness/core");
  return new PluginInstaller(getPluginsDir());
}

export async function listInstalled(): Promise<string[]> {
  const installer = await getInstaller();
  return installer.listInstalled();
}

export async function installPlugin(source: string): Promise<string> {
  const installer = await getInstaller();
  return installer.install(source);
}

export async function uninstallPlugin(name: string): Promise<boolean> {
  const installer = await getInstaller();
  return installer.uninstall(name);
}
