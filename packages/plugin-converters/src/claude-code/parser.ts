import { access, lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { SourceInspection } from "../core/converter.js";
const exists = async (path: string) => access(path).then(() => true, () => false);
async function collect(root: string, path: string, extensions?: string[]): Promise<string[]> {
  if (!(await exists(path))) return [];
  const info = await lstat(path); if (info.isSymbolicLink()) throw new Error(`Claude source symlink is not allowed: ${path}`);
  if (info.isFile()) return !extensions || extensions.some((x) => path.toLowerCase().endsWith(x)) ? [path] : [];
  const result: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Claude source symlink is not allowed: ${entry.name}`);
    const full = join(path, entry.name); if (entry.isDirectory()) result.push(...await collect(root, full, extensions)); else if (!extensions || extensions.some((x) => entry.name.toLowerCase().endsWith(x))) result.push(full);
  }
  return result;
}
const asPaths = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) && value.every((x) => typeof x === "string") ? value : [];
function safe(root: string, value: string): string { const target = resolve(root, value); const rel = relative(resolve(root), target); if (rel.startsWith("..") || isAbsolute(rel) || target === resolve(root)) throw new Error(`Claude component path escapes source: ${value}`); return target; }
export async function inspectClaudeCodePlugin(rootInput: string): Promise<SourceInspection> {
  const root = resolve(rootInput); let manifest: Record<string, unknown> = {};
  const manifestPath = join(root, ".claude-plugin", "plugin.json");
  if (await exists(manifestPath)) manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const name = typeof manifest.name === "string" ? manifest.name : basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const inventory: Record<string, string[]> = {};
  const skillRoots = [join(root, "skills"), ...asPaths(manifest.skills).map((x) => safe(root, x))];
  if (await exists(join(root, "SKILL.md"))) skillRoots.push(join(root, "SKILL.md"));
  inventory.skills = (await Promise.all(skillRoots.map((x) => collect(root, x, ["skill.md"])))).flat();
  for (const kind of ["commands", "agents"] as const) {
    const custom = asPaths(manifest[kind]); const roots = custom.length ? custom.map((x) => safe(root, x)) : [join(root, kind)];
    inventory[kind] = (await Promise.all(roots.map((x) => collect(root, x, [".md"])))).flat();
  }
  const hooks = join(root, "hooks", "hooks.json");
  const mcp = join(root, ".mcp.json");
  inventory.hooks = await exists(hooks) ? [hooks] : [];
  inventory.mcpServers = await exists(mcp) ? [mcp] : [];
  return { root, format: "claude-code", identity: { id: `converted.claude.${name}`, name, version: typeof manifest.version === "string" ? manifest.version : "0.0.0" }, inventory, diagnostics: [] };
}
