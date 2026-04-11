import type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  IPermissionChecker,
  PermissionSettings,
  PathRuleConfig,
} from "@openharness/core";

export type {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  PermissionSettings,
  PathRuleConfig,
};

export interface PermissionCheckOptions {
  mode: PermissionMode;
  rules?: PermissionRule[];
  allowedTools?: string[];
  deniedTools?: string[];
  pathRules?: PathRuleConfig[];
  deniedCommands?: string[];
}

export class PermissionChecker implements IPermissionChecker {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private allowedTools: Set<string>;
  private deniedTools: Set<string>;
  private pathRules: PathRuleConfig[];
  private deniedCommands: string[];

  constructor(options: PermissionCheckOptions | PermissionSettings) {
    if ("mode" in options && "allowedTools" in options) {
      const s = options as PermissionSettings;
      this.mode = s.mode;
      this.rules = [];
      this.allowedTools = new Set(s.allowedTools ?? []);
      this.deniedTools = new Set(s.deniedTools ?? []);
      this.pathRules = s.pathRules ?? [];
      this.deniedCommands = s.deniedCommands ?? [];
    } else {
      const o = options as PermissionCheckOptions;
      this.mode = o.mode;
      this.rules = o.rules ?? [];
      this.allowedTools = new Set(o.allowedTools ?? []);
      this.deniedTools = new Set(o.deniedTools ?? []);
      this.pathRules = o.pathRules ?? [];
      this.deniedCommands = o.deniedCommands ?? [];
    }
  }

  async checkTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionDecision> {
    if (this.mode === "full_auto") {
      return { action: "allow", reason: "Full auto mode" };
    }

    if (this.deniedTools.size > 0 && this.deniedTools.has(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is in denied list` };
    }

    if (this.allowedTools.size > 0 && !this.allowedTools.has(toolName)) {
      return { action: "deny", reason: `Tool '${toolName}' is not in allowed list` };
    }

    if (this.deniedCommands.length > 0 && typeof input.command === "string") {
      for (const pattern of this.deniedCommands) {
        if (matchPattern(pattern, input.command)) {
          return { action: "deny", reason: `Command matches denied pattern: ${pattern}` };
        }
      }
    }

    if (this.pathRules.length > 0) {
      const path = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : "";
      if (path) {
        for (const rule of this.pathRules) {
          if (matchPattern(rule.pattern, path)) {
            return rule.allow
              ? { action: "allow", reason: `Path matched allow rule: ${rule.pattern}` }
              : { action: "deny", reason: `Path matched deny rule: ${rule.pattern}` };
          }
        }
      }
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
