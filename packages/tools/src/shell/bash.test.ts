import { describe, expect, it } from "vitest";

import { diagnoseShellDialectMismatch } from "./bash.js";
import type { HostShellLauncher } from "@openharness/sandbox";

describe("diagnoseShellDialectMismatch", () => {
  const powershell: HostShellLauncher = { kind: "powershell", bin: "powershell.exe" };
  const cmd: HostShellLauncher = { kind: "cmd", bin: "cmd.exe" };
  const bash: HostShellLauncher = { kind: "bash", bin: "bash.exe" };

  it("flags obvious Bash syntax when PowerShell is active", () => {
    const problems = diagnoseShellDialectMismatch(
      "ls -la /tmp/dscode 2>/dev/null && head -5 README.md",
      powershell,
    );

    expect(problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(["ls-la", "posix-temp-path", "dev-null", "head", "powershell-control-operator"]),
    );
  });

  it("flags POSIX paths when cmd.exe is active", () => {
    const problems = diagnoseShellDialectMismatch("find / -name dscode 2>/dev/null", cmd);

    expect(problems.map((problem) => problem.code)).toEqual(expect.arrayContaining(["find-root", "dev-null"]));
  });

  it("does not flag Bash syntax when bash is active", () => {
    expect(diagnoseShellDialectMismatch("ls -la /tmp 2>/dev/null", bash)).toEqual([]);
  });
});
