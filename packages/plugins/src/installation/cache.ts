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

async function pruneLegacyVersionCacheDirectories(parent: string): Promise<void> {
  const legacyVersionDirectory = /^.+-[a-f0-9]{64}$/i;
  await Promise.all((await readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && legacyVersionDirectory.test(entry.name))
    .map((entry) => rm(join(parent, entry.name), { recursive: true, force: true }).catch(() => undefined)));
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
  digest: string,
  validateCandidate?: (candidatePath: string) => Promise<void>,
): Promise<string> {
  const parent = join(cacheRoot, pluginId);
  const target = join(parent, "current");
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.tmp-${digest}-${randomUUID()}`);
  const previous = join(parent, `.previous-${digest}-${randomUUID()}`);
  let previousExists = false;
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    await validateCandidate?.(temporary);
    try {
      if ((await stat(target)).isDirectory()) {
        await rename(target, previous);
        previousExists = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(temporary, target);
    if (previousExists) await rm(previous, { recursive: true, force: true });
    await pruneLegacyVersionCacheDirectories(parent);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (previousExists) {
      try { await rename(previous, target); } catch {}
    }
    throw error;
  }
}
