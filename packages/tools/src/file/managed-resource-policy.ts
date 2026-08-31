import { resolve, sep } from "node:path";

import type { AgentManagedResourcePolicy, ManagedResourceDecision, ManagedResourceOperation } from "@openharness/core";

export class ManagedResourcePolicy implements AgentManagedResourcePolicy {
  private readonly directories: string[];
  private readonly files: Set<string>;

  constructor(input: { directories?: string[]; files?: string[] }) {
    this.directories = (input.directories ?? []).map(canonicalPath);
    this.files = new Set((input.files ?? []).map(canonicalPath));
  }

  check(path: string, _operation: ManagedResourceOperation): ManagedResourceDecision {
    const target = canonicalPath(path);
    if (this.files.has(target) || this.directories.some((directory) => target === directory || target.startsWith(`${directory}/`))) {
      return { allowed: false, reason: "managed context resource" };
    }
    return { allowed: true };
  }
}

function canonicalPath(value: string): string {
  return resolve(value.replace(/[\\/]+/gu, sep)).replace(/\\/gu, "/").replace(/\/+$/u, "").toLocaleLowerCase("en-US");
}
