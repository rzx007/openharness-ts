import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";

async function filesUnder(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, full));
    else if (entry.isFile()) files.push(full);
    else if (entry.isSymbolicLink()) throw new Error(`Cache source contains a symbolic link: ${relative(root, full)}`);
  }
  return files;
}

export async function computePluginBehaviorDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await filesUnder(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function materializePluginCache(
  source: string,
  cacheRoot: string,
  pluginId: string,
  version: string,
  digest: string,
): Promise<string> {
  const parent = join(cacheRoot, pluginId);
  const target = join(parent, `${version}-${digest}`);
  try { if ((await stat(target)).isDirectory()) return target; } catch {}
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.tmp-${randomUUID()}`);
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    try { if ((await stat(target)).isDirectory()) return target; } catch {}
    throw error;
  }
}
