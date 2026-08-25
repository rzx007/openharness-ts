import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateNativePlugin } from "./manifest/validate.js";
import { loadNativePlugin } from "./load-native-plugin.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/native-v1/${name}`, import.meta.url));

describe("loadNativePlugin", () => {
  it("keeps independent components when one component is invalid", async () => {
    const validation = await validateNativePlugin(fixture("invalid-component"));
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.status).toBe("degraded");
    expect(loaded.components.skills?.status).toBe("loaded");
    expect(loaded.components.skills?.value).toHaveLength(1);
    expect(loaded.components.hooks?.status).toBe("invalid");
  });

  it("recognizes tools but never imports them", async () => {
    const validation = await validateNativePlugin(fixture("unsupported-tool"));
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.components.tools?.status).toBe("unsupported");
    expect(loaded.diagnostics.map((item) => item.code)).toContain("native_tools_not_activatable");
  });
});
