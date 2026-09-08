export type ShellFamily = "powershell" | "cmd" | "posix";

export type ShellDialect =
  | "windows-powershell"
  | "pwsh"
  | "cmd"
  | "bash"
  | "posix-sh"
  | "zsh";

export interface ShellDescriptor {
  family: ShellFamily;
  dialect: ShellDialect;
  executable: string;
  argsPrefix: string[];
  displayName: string;
  version?: string;
  pathStyle: "windows" | "posix";
  tempDir: string;
  capabilities: {
    conditionalAndOr: boolean;
    supportsLoginShell: boolean;
  };
}

export interface ShellResultMetadata {
  shellFamily: ShellDescriptor["family"];
  shellDialect: ShellDescriptor["dialect"];
  shellExecutable: string;
  shellDisplayName: string;
  pathStyle: ShellDescriptor["pathStyle"];
  exitCode: number | null;
  status: "completed" | "failed" | "timed_out" | "interrupted";
}

export function shellArgv(shell: ShellDescriptor, command: string): string[] {
  return [shell.executable, ...shell.argsPrefix, command];
}

export function shellResultMetadata(
  shell: ShellDescriptor,
  exitCode: number | null,
  status: ShellResultMetadata["status"],
): ShellResultMetadata {
  return {
    shellFamily: shell.family,
    shellDialect: shell.dialect,
    shellExecutable: shell.executable,
    shellDisplayName: shell.displayName,
    pathStyle: shell.pathStyle,
    exitCode,
    status,
  };
}
