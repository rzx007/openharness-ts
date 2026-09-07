import { describe, expect, it } from "vitest";

import { deriveInstallationId } from "./installation-id.js";

describe("deriveInstallationId", () => {
  it("normalizes Windows data directories without exposing the path", () => {
    const first = deriveInstallationId(
      "C:\\Users\\A\\.openharness-ts\\data",
      "win32",
    );
    const second = deriveInstallationId(
      "c:/users/a/.openharness-ts/data/",
      "win32",
    );

    expect(first).toBe("d9e8f4d13a36f900cbd39c548b2c0740");
    expect(second).toBe(first);
    expect(first).not.toContain("users");
  });

  it("keeps POSIX path casing significant", () => {
    expect(deriveInstallationId("/home/a/.openharness-ts/data", "linux"))
      .toBe("845ff509466654dfe7bb65cfd374ea8c");
    expect(deriveInstallationId("/Home/a/.openharness-ts/data", "linux"))
      .not.toBe("845ff509466654dfe7bb65cfd374ea8c");
  });
});
