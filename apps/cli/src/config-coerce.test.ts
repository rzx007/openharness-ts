import { describe, expect, it } from "vitest";

import { buildSettingsPatch, coerceConfigValue } from "./config-coerce.js";

describe("config coerce helpers", () => {
  it("coerces booleans and nested memory keys", () => {
    expect(coerceConfigValue("fastMode", "on")).toBe(true);
    expect(coerceConfigValue("memory.enabled", "false")).toBe(false);
    expect(coerceConfigValue("permission.mode", "plan")).toBe("plan");
    expect(coerceConfigValue("permission.mode", "nope")).toBeUndefined();
  });

  it("builds nested settings patches", () => {
    expect(buildSettingsPatch({ memory: { enabled: true } }, "memory.enabled", false)).toEqual({
      memory: { enabled: false },
    });
    expect(buildSettingsPatch({}, "model", "gpt-x")).toEqual({ model: "gpt-x" });
  });
});
