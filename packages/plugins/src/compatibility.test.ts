import { describe, expect, it } from "vitest";
import { buildNativePluginCompatibilityEnvironment } from "./compatibility.js";
describe("buildNativePluginCompatibilityEnvironment", () => {
  it("exposes only explicitly requested, known aliases", () => {
    const env = buildNativePluginCompatibilityEnvironment({ root: "C:/plugin", cwd: "C:/work", manifest: {
      schemaVersion: 1, id: "dev.example.converted", name: "converted", version: "1",
      components: { skills: ["./payload/skills"] }, compatibility: { environmentAliases: ["CLAUDE_PLUGIN_ROOT", "HOST_SECRET"] },
    } });
    expect(env.CLAUDE_PLUGIN_ROOT).toContain("payload"); expect(env.HOST_SECRET).toBeUndefined();
  });
});
