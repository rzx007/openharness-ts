import { z } from "zod";
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

  private async resolveManifest(
    _pluginPath: string
  ): Promise<PluginManifest> {
    return { name: "placeholder", version: "0.1.0" };
  }
}

export class PluginInstaller {
  private installDir: string;

  constructor(installDir: string) {
    this.installDir = installDir;
  }

  async install(source: string): Promise<string> {
    return source;
  }

  async uninstall(name: string): Promise<boolean> {
    void name;
    return false;
  }

  async listInstalled(): Promise<string[]> {
    return [];
  }
}
