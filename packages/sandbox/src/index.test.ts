import { describe, it, expect } from "vitest";
import { SandboxAdapter } from "./index.js";

describe("SandboxAdapter", () => {
  it("isAvailable returns false", () => {
    const adapter = new SandboxAdapter();
    expect(adapter.isAvailable()).toBe(false);
  });

  it("execute throws not implemented", async () => {
    const adapter = new SandboxAdapter();
    await expect(adapter.execute("ls")).rejects.toThrow(
      "Sandbox not yet implemented"
    );
  });

  it("accepts config", () => {
    const adapter = new SandboxAdapter({ runtime: "docker", image: "node:20" });
    expect(adapter.isAvailable()).toBe(false);
  });
});
