import type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  IPermissionChecker,
} from "@openharness/core";

export type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
};

export interface PermissionCheckOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export class PermissionChecker implements IPermissionChecker {
  private mode: PermissionMode;
  private rules: PermissionRule[];

  constructor(options: PermissionCheckOptions) {
    this.mode = options.mode;
    this.rules = options.rules;
  }

  async checkTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    if (this.mode === "full_auto") {
      return { action: "allow", reason: "Full auto mode" };
    }

    for (const rule of this.rules) {
      if (rule.tool && rule.tool !== toolName) continue;
      if (
        rule.pathPattern &&
        typeof input.path === "string" &&
        !matchPattern(rule.pathPattern, input.path)
      ) {
        continue;
      }
      if (
        rule.commandPattern &&
        typeof input.command === "string" &&
        !matchPattern(rule.commandPattern, input.command)
      ) {
        continue;
      }
      return {
        action: rule.action,
        reason: `Matched rule for tool: ${rule.tool ?? "*"}`,
      };
    }

    if (this.mode === "plan") {
      return { action: "ask", reason: "Plan mode requires confirmation" };
    }

    return { action: "ask", reason: "No matching rule found" };
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(index: number): void {
    this.rules.splice(index, 1);
  }

  getRules(): readonly PermissionRule[] {
    return this.rules;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }
}

function matchPattern(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(value);
}
