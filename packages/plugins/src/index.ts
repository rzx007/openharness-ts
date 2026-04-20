import { z } from "zod";
import { readFile, readdir, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@openharness/core";

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: unknown[];
  init?: (context: PluginContext) => Promise<void>;
}

export interface PluginContext {
  pluginDir: string;
  config: Record<string, unknown>;
}

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
});

export interface PluginLoadResult {
  manifest: PluginManifest;
  path: string;
  loaded: boolean;
  error?: Error;
}

export class PluginLoader {
  private loaded = new Map<string, PluginLoadResult>();

  async loadFromPath(pluginPath: string): Promise<PluginLoadResult> {
    try {
      const manifest = await this.resolveManifest(pluginPath);
      const result: PluginLoadResult = {
        manifest,
        path: pluginPath,
        loaded: true,
      };
      this.loaded.set(manifest.name, result);
      return result;
    } catch (err) {
      const result: PluginLoadResult = {
        manifest: { name: "", version: "0.0.0" },
        path: pluginPath,
        loaded: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
      return result;
    }
  }

  async loadMany(paths: string[]): Promise<PluginLoadResult[]> {
    return Promise.all(paths.map((p) => this.loadFromPath(p)));
  }

  getLoaded(): readonly PluginLoadResult[] {
    return [...this.loaded.values()];
  }

  get(name: string): PluginLoadResult | undefined {
    return this.loaded.get(name);
  }

  unload(name: string): void {
    this.loaded.delete(name);
  }

  async resolveManifest(pluginPath: string): Promise<PluginManifest> {
    const manifestPath = join(pluginPath, "plugin.json");
    const raw = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    return PluginManifestSchema.parse(parsed) as PluginManifest;
  }
}

export class PluginInstaller {
  private installDir: string;

  constructor(installDir: string) {
    this.installDir = installDir;
  }

  async install(source: string): Promise<string> {
    const name = source.split("/").pop() ?? source;
    const target = join(this.installDir, name);
    await mkdir(target, { recursive: true });
    const manifest: PluginManifest = { name, version: "1.0.0" };
    const { writeFile } = await import("node:fs/promises");
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
