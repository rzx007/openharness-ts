import { mkdir, open, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ContextScope, ContextTopic } from "@openharness/context";

const TOPICS_BY_SCOPE: Record<ContextScope, readonly ContextTopic[]> = {
  user: ["preferences", "ui-design", "development-workflow", "pending"],
  machine: ["environment", "pending"],
  project: ["rules", "knowledge", "environment", "pending"],
};

export interface ContextScopeRef {
  scope: ContextScope;
  scopeKey: string;
}

export interface ContextDocumentRef extends ContextScopeRef {
  topic: ContextTopic;
}

export class ContextPaths {
  readonly root: string;
  private machineIdPromise?: Promise<string>;

  constructor(root: string) {
    this.root = resolve(root);
  }

  getOrCreateMachineId(): Promise<string> {
    this.machineIdPromise ??= this.initializeMachineId();
    return this.machineIdPromise;
  }

  directoryFor(ref: ContextScopeRef): string {
    assertScopeKey(ref.scope, ref.scopeKey);
    const directory = ref.scope === "user"
      ? join(this.root, "user")
      : ref.scope === "machine"
        ? join(this.root, "machine", ref.scopeKey)
        : join(this.root, "projects", ref.scopeKey);
    assertManagedPath(this.root, directory);
    return directory;
  }

  documentFor(ref: ContextDocumentRef): string {
    if (!TOPICS_BY_SCOPE[ref.scope].includes(ref.topic)) {
      throw new Error(`Invalid topic ${ref.topic} for ${ref.scope} scope`);
    }
    const path = join(this.directoryFor(ref), `${ref.topic}.md`);
    assertManagedPath(this.root, path);
    return path;
  }

  topicsFor(scope: ContextScope): readonly ContextTopic[] {
    return TOPICS_BY_SCOPE[scope];
  }

  private async initializeMachineId(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, ".machine-id");
    try {
      return validateStoredMachineId((await readFile(path, "utf8")).trim());
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const candidate = randomUUID();
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${candidate}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return validateStoredMachineId((await readFile(path, "utf8")).trim());
    }
  }
}

function assertScopeKey(scope: ContextScope, scopeKey: string): void {
  if (scope === "user" && scopeKey !== "local-user") throw new Error("Invalid scope key for user scope");
  if (
    !scopeKey
    || scopeKey === "."
    || scopeKey === ".."
    || isAbsolute(scopeKey)
    || /[\\/]/u.test(scopeKey)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(scopeKey)
  ) throw new Error(`Invalid scope key: ${scopeKey}`);
}

function assertManagedPath(root: string, path: string): void {
  const pathFromRoot = relative(root, resolve(path));
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("Resolved context path is outside the managed root");
  }
}

function validateStoredMachineId(value: string): string {
  assertScopeKey("machine", value);
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
