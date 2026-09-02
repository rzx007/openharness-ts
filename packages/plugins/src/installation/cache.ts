import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

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

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function assertRegularPluginCacheSnapshot(target: string): Promise<void> {
  const parent = dirname(target);
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Plugin cache snapshot is not a regular directory: ${target}`);
  }

  const [resolvedParent, resolvedTarget] = await Promise.all([
    realpath(parent),
    realpath(target),
  ]);
  const expectedTarget = join(resolvedParent, basename(target));
  if (comparablePath(resolvedTarget) !== comparablePath(expectedTarget)) {
    throw new Error(`Plugin cache snapshot is not a regular directory: ${target}`);
  }
}

async function regularSnapshotExists(target: string): Promise<boolean> {
  try {
    await assertRegularPluginCacheSnapshot(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function materializePluginCache(
  source: string,
  cacheRoot: string,
  pluginId: string,
  version: string,
  digest: string,
  validateCandidate?: (candidatePath: string) => Promise<void>,
): Promise<string> {
  const parent = join(cacheRoot, pluginId);
  const safeVersion = version.replace(/[^a-zA-Z0-9._-]/g, "_");
  const target = join(parent, `${safeVersion}-${digest}`);
  await mkdir(parent, { recursive: true });

  let quarantined: string | undefined;
  if (await regularSnapshotExists(target)) {
    let digestMatches = false;
    try {
      digestMatches = await computePluginBehaviorDigest(target) === digest;
    } catch {
      // An unreadable entry or nested link makes the snapshot corrupt. Isolate it
      // using the root directory entry only, then rebuild from the trusted source.
    }
    if (digestMatches) {
      await validateCandidate?.(target);
      return target;
    }

    quarantined = join(parent, `.corrupt-${basename(target)}-${randomUUID()}`);
    await rename(target, quarantined);
  }

  const temporary = join(parent, `.tmp-${digest}-${randomUUID()}`);
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
    if (await computePluginBehaviorDigest(temporary) !== digest) {
      throw new Error("Plugin source changed while it was being cached");
    }
    await validateCandidate?.(temporary);
    await rename(temporary, target);
    if (quarantined) await rm(quarantined, { recursive: true, force: true });
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    try {
      if (await regularSnapshotExists(target)
        && await computePluginBehaviorDigest(target) === digest) {
        await validateCandidate?.(target);
        if (quarantined) await rm(quarantined, { recursive: true, force: true });
        return target;
      }
    } catch (fallbackError) {
      if ((fallbackError as Error).message.startsWith("Plugin cache snapshot is not a regular directory:")) {
        throw fallbackError;
      }
    }
    throw error;
  }
}
