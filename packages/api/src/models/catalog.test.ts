import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ModelCatalogService fallback merge", () => {
  it("does not duplicate DeepSeek fallback models already supplied by models.dev", async () => {
    const configDirectory = await mkdtemp(
      join(tmpdir(), "openharness-model-catalog-"),
    );
    temporaryDirectories.push(configDirectory);
    const cacheDirectory = join(configDirectory, "cache");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      join(cacheDirectory, "models-dev.json"),
      JSON.stringify({
        deepseek: {
          id: "deepseek",
          name: "DeepSeek",
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              reasoning: true,
            },
          },
        },
      }),
      "utf8",
    );
    vi.stubEnv("OPENHARNESS_CONFIG_DIR", configDirectory);
    vi.stubEnv("OPENHARNESS_DISABLE_MODELS_FETCH", "1");

    const { createModelCatalogService } = await import("./catalog");
    const catalog = await createModelCatalogService().load();
    const matchingModels = Object.values(catalog.deepseek?.models ?? {}).filter(
      (model) => model.name === "DeepSeek V4 Flash",
    );

    expect(matchingModels).toEqual([
      expect.objectContaining({
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
      }),
    ]);
  });
});
