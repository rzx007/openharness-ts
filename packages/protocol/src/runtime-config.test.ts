import { describe, expect, it } from "vitest";

import {
  patchSessionRuntimeMetadata,
  readRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
  type SessionRecord,
} from "./index.js";

function session(metadata: Record<string, unknown>): SessionRecord {
  return {
    id: "session-1",
    cwd: "/repo",
    title: "Session",
    model: "display-only-model",
    status: "idle",
    metadata,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("session runtime metadata", () => {
  it("reads the model only from metadata.runtime", () => {
    expect(() => readSessionRuntimeConfig(session({}))).toThrow(
      /metadata\.runtime\.model/,
    );
    expect(
      readSessionRuntimeConfig(
        session({ runtime: { model: "runtime-model", apiFormat: "openai" } }),
      ),
    ).toEqual({ model: "runtime-model", apiFormat: "openai" });
  });

  it("preserves an explicit false plugin runtime override", () => {
    expect(readSessionRuntimeConfig(
      session({ runtime: { model: "runtime-model", pluginsEnabled: false } }),
      { pluginsEnabled: true },
    )).toMatchObject({ model: "runtime-model", pluginsEnabled: false });
  });

  it("patches runtime fields without discarding unrelated metadata", () => {
    expect(
      patchSessionRuntimeMetadata(
        { source: "desktop", runtime: { model: "old", provider: "openai" } },
        { model: "new", provider: undefined },
      ),
    ).toEqual({
      source: "desktop",
      runtime: { model: "new", provider: "openai" },
    });
  });

  it("compares runtime metadata without treating other metadata as a restart", () => {
    expect(
      runtimeMetadataChanged(
        { runtime: { model: "m" }, titleSource: "a" },
        { runtime: { model: "m" }, titleSource: "b" },
      ),
    ).toBe(false);
    expect(
      runtimeMetadataChanged(
        { runtime: { model: "m" } },
        { runtime: { model: "next" } },
      ),
    ).toBe(true);
    expect(readRuntimeMetadata(undefined)).toEqual({});
  });
});
