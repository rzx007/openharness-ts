import { describe, expect, it } from "vitest";
import { buildNativePluginCompatibilityEnvironment } from "./compatibility.js";
describe("buildNativePluginCompatibilityEnvironment", () => {
  it("does not expose source-runtime aliases for Native plugins", () => {
    const env = buildNativePluginCompatibilityEnvironment({ root: "C:/plugin", cwd: "C:/work", manifest: {
      schemaVersion: 1, id: "dev.example.converted", name: "converted", version: "1",
      components: { skills: ["./payload/skills"] }, compatibility: { environmentAliases: ["CLAUDE_PLUGIN_ROOT", "HOST_SECRET"] },
    } });
    expect(env).toEqual({});
  });
});
