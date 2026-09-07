import type { EnvironmentPtyTarget } from "@openharness/environment";

export function createHostTerminalTarget(input: {
  cwd: string;
  shell: string;
}): EnvironmentPtyTarget {
  return {
    command: input.shell,
    args: [],
    hostCwd: input.cwd,
    executionCwd: input.cwd,
    shell: input.shell,
    async signal() {},
    async close() {},
  };
}
