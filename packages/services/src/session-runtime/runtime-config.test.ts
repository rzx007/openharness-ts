import { describe, expect, it } from "vitest";

import {
  patchSessionRuntimeMetadata,
  readSessionRuntimeConfig,
  runtimeMetadataChanged,
} from "./runtime-config.js";
import type { SessionRecord } from "./types.js";

function session(metadata: Record<string, unknown> = {}): SessionRecord {
  return {
    id: "s1",
    cwd: "/repo",
    title: "Session",
    model: "legacy-model",
    status: "idle",
    metadata,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("session runtime config", () => {
  it("requires the model to live in runtime metadata", () => {
    expect(() => readSessionRuntimeConfig(session())).toThrow(
      "Session runtime config is missing metadata.runtime.model: s1",
    );
    expect(readSessionRuntimeConfig(session({
      runtime: { model: "runtime-model", provider: "openrouter", permissionMode: "plan" },
    }))).toMatchObject({
      model: "runtime-model",
      provider: "openrouter",
      permissionMode: "plan",
    });
  });

  it("patches runtime metadata without touching unrelated metadata", () => {
    expect(patchSessionRuntimeMetadata({
      titleSource: "user",
      runtime: { model: "old", provider: "openrouter", maxTurns: 8 },
    }, {
      model: "new",
    })).toEqual({
      titleSource: "user",
      runtime: { model: "new", provider: "openrouter", maxTurns: 8 },
    });
  });

  it("detects only runtime config changes", () => {
    expect(runtimeMetadataChanged(
      { label: "a", runtime: { model: "m" } },
      { label: "b", runtime: { model: "m" } },
    )).toBe(false);
    expect(runtimeMetadataChanged(
      { runtime: { model: "m" } },
      { runtime: { model: "next" } },
    )).toBe(true);
  });
});
