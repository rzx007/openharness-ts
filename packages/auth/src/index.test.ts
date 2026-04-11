import { describe, it, expect } from "vitest";
import { ApiKeyFlow, DeviceCodeFlow, AuthManager } from "../src/index.js";

describe("ApiKeyFlow", () => {
  it("returns credentials with the provided key", async () => {
    const flow = new ApiKeyFlow("sk-test-123");
    const creds = await flow.authenticate();
    expect(creds.provider).toBe("api-key");
    expect(creds.accessToken).toBe("sk-test-123");
  });

  it("refresh returns same key", async () => {
    const flow = new ApiKeyFlow("sk-test");
    const creds = await flow.refresh({ provider: "api-key", accessToken: "old" });
    expect(creds.accessToken).toBe("sk-test");
  });
});

describe("DeviceCodeFlow", () => {
  it("exposes name", () => {
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    expect(flow.name).toBe("device-code");
  });

  it("authenticate returns credentials", async () => {
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    const creds = await flow.authenticate();
    expect(creds.provider).toBe("device-code");
    expect(creds.accessToken).toBeTruthy();
  });

  it("refresh returns updated credentials", async () => {
    const flow = new DeviceCodeFlow("client-id", "https://start", "https://token");
    const original = { provider: "device-code", accessToken: "old-token" };
    const refreshed = await flow.refresh(original);
    expect(refreshed.accessToken).toBeTruthy();
  });
});

describe("AuthManager", () => {
  it("registers and authenticates with provider", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("sk-test"));
    const creds = await mgr.authenticate("api-key");
    expect(creds.accessToken).toBe("sk-test");
  });

  it("throws for unknown provider", async () => {
    const mgr = new AuthManager();
    await expect(mgr.authenticate("nope")).rejects.toThrow("Unknown auth provider");
  });

  it("stores credentials after authenticate", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("sk-test"));
    await mgr.authenticate("api-key");
    const stored = mgr.getCredentials("api-key");
    expect(stored).toBeDefined();
    expect(stored!.accessToken).toBe("sk-test");
  });

  it("getCredentials returns undefined before authenticate", () => {
    const mgr = new AuthManager();
    expect(mgr.getCredentials("api-key")).toBeUndefined();
  });

  it("can register different provider types", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("sk-test"));
    mgr.registerProvider(new DeviceCodeFlow("cid", "https://start", "https://token"));
    const c1 = await mgr.authenticate("api-key");
    expect(c1.accessToken).toBe("sk-test");
    const c2 = await mgr.authenticate("device-code");
    expect(c2.accessToken).toBeTruthy();
  });

  it("last registered provider wins for same name", async () => {
    const mgr = new AuthManager();
    mgr.registerProvider(new ApiKeyFlow("first"));
    mgr.registerProvider(new ApiKeyFlow("second"));
    const creds = await mgr.authenticate("api-key");
    expect(creds.accessToken).toBe("second");
  });
});
