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

  it("loads tool metadata but never imports tool code", async () => {
    const validation = await validateNativePlugin(fixture("unsupported-tool"));
    const loaded = await loadNativePlugin(validation.plugin!);
    expect(loaded.components.tools?.status).toBe("loaded");
    expect(loaded.components.tools?.value?.[0]).toMatchObject({
      declaredEntry: "./tools/index.js",
      runtime: "node",
      requestedPermissions: [],
    });
  });
});
