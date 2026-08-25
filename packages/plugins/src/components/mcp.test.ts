import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "../manifest/validate.js";
import { loadNativeMcpServers } from "./mcp.js";

const fixture = fileURLToPath(new URL("../../fixtures/native-v1/agents-hooks-mcp", import.meta.url));

describe("loadNativeMcpServers", () => {
  it("requires and loads explicit Native transports", async () => {
    const validation = await validateNativePlugin(fixture);
    const result = await loadNativeMcpServers(validation.plugin!);
    expect(result.status).toBe("loaded");
    expect(result.value).toEqual(expect.objectContaining({
      local: expect.objectContaining({ type: "stdio" }),
      remote: expect.objectContaining({ type: "http" }),
    }));
  });
});
