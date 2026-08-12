import { describe, expect, it } from "vitest";

import { assertSafeDaemonBinding, daemonHealthUrl, isLoopbackHost } from "./daemon.js";

describe("daemon remote binding", () => {
  it("accepts loopback hosts without an explicit token", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(() => assertSafeDaemonBinding({ host: "127.0.0.1" })).not.toThrow();
  });

  it("requires an explicit token for non-loopback hosts", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(() => assertSafeDaemonBinding({ host: "0.0.0.0" })).toThrow(/explicit --token/);
    expect(() => assertSafeDaemonBinding({ host: "0.0.0.0", token: "shared-secret" })).not.toThrow();
  });

  it("prints the health URL for status checks", () => {
    expect(daemonHealthUrl("http://127.0.0.1:61629")).toBe("http://127.0.0.1:61629/health");
    expect(daemonHealthUrl("http://127.0.0.1:61629/")).toBe("http://127.0.0.1:61629/health");
  });
});
