import { describe, expect, it } from "vitest";

import {
  checkProtocolCompatibility,
  parseServerCapabilities,
  supportsFeature,
} from "./capabilities.js";

describe("protocol capabilities", () => {
  const server = parseServerCapabilities({
    serverVersion: "0.4.0",
    protocol: { version: 2 },
    features: { jobs: 2, workflow: 2 },
  });

  it("accepts only an exact protocol version", () => {
    expect(checkProtocolCompatibility(server, { version: 2 })).toEqual({ compatible: true });
    expect(supportsFeature(server, "jobs", 2)).toBe(true);
    expect(supportsFeature(server, "backup", 1)).toBe(false);
  });

  it("rejects older and newer protocol versions", () => {
    expect(checkProtocolCompatibility(server, { version: 1 })).toMatchObject({ compatible: false });
    expect(checkProtocolCompatibility(server, { version: 3 })).toMatchObject({ compatible: false });
  });

  it("rejects malformed feature versions", () => {
    expect(() => parseServerCapabilities({
      serverVersion: "x",
      protocol: { version: 2 },
      features: { jobs: 0 },
    })).toThrow("features.jobs");
  });
});
