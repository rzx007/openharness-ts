import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digestValue(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
async function files(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${relative(root, full)}`);
    if (entry.isDirectory()) out.push(...await files(root, full)); else if (entry.isFile()) out.push(full);
  }
  return out;
}
export async function digestSource(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await files(root)) { hash.update(relative(root, file).replaceAll("\\", "/")); hash.update("\0"); hash.update(await readFile(file)); hash.update("\0"); }
  return hash.digest("hex");
}
