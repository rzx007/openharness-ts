import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SandboxOperation,
  SandboxPathValidationResult,
  ValidateSandboxPathOptions,
} from "./types.js";
import { normalizeSandboxConfig } from "./config.js";

export async function validateSandboxPath(
  targetPath: string,
  options: ValidateSandboxPathOptions,
): Promise<SandboxPathValidationResult> {
  const config = normalizeSandboxConfig(options.config);
  const operation = options.operation;
  const sandboxRoot = await canonicalizeExistingPath(resolve(options.sandboxRoot));
  const resolvedPath = resolve(options.sandboxRoot, targetPath);
  const canonicalPath = await canonicalizePossiblyMissingPath(resolvedPath);
  const roots = await allowedRootsForOperation(options, operation, sandboxRoot);
  const denyPatterns = operation === "read"
    ? config.filesystem.denyRead
    : config.filesystem.denyWrite;

  for (const pattern of denyPatterns) {
    const deniedRoot = await canonicalizeRulePath(pattern, sandboxRoot);
    if (isPathInside(canonicalPath, deniedRoot)) {
      return {
        allowed: false,
        resolvedPath: canonicalPath,
        reason: `path ${canonicalPath} is denied by sandbox rule ${pattern}`,
      };
    }
  }

  if (!roots.some((root) => isPathInside(canonicalPath, root))) {
    return {
      allowed: false,
      resolvedPath: canonicalPath,
      reason: `path ${canonicalPath} is outside the sandbox boundary (${sandboxRoot})`,
    };
  }

  return { allowed: true, resolvedPath: canonicalPath };
}

async function allowedRootsForOperation(
  options: ValidateSandboxPathOptions,
  operation: SandboxOperation,
  sandboxRoot: string,
): Promise<string[]> {
  const config = normalizeSandboxConfig(options.config);
  const allowRules = operation === "read"
    ? config.filesystem.allowRead
    : config.filesystem.allowWrite;
  const extraRules = [
    ...config.filesystem.extraAllowedRoots,
    ...(options.extraAllowedRoots ?? []),
  ];
  const roots = [...allowRules, ...extraRules];
  const normalized = roots.length > 0 ? roots : ["."];
  return Promise.all(normalized.map((rule) => canonicalizeRulePath(rule, sandboxRoot)));
}

async function canonicalizeRulePath(rule: string, sandboxRoot: string): Promise<string> {
  const absolute = isAbsolute(rule) ? rule : resolve(sandboxRoot, rule);
  return canonicalizePossiblyMissingPath(absolute);
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function canonicalizePossiblyMissingPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await nearestExistingParent(absolute);
    const parentReal = await canonicalizeExistingPath(parent);
    const tail = relative(parent, absolute);
    return tail ? resolve(parentReal, tail) : parentReal;
  }
}

async function nearestExistingParent(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel) && !rel.includes(`..${sep}`));
}
