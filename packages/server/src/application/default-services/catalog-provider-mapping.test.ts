import { describe, expect, it } from "vitest";

import { readCatalogProvider } from "./catalog-provider-mapping.js";

describe("catalog provider aliases", () => {
  it.each([
    ["zhipu", "zhipuai"],
    ["moonshot", "moonshotai"],
  ])("maps the built-in %s provider to models.dev %s", (providerName, catalogId) => {
    const provider = { name: catalogId, models: { chat: {} } };

    expect(readCatalogProvider({ [catalogId]: provider }, providerName)).toBe(provider);
  });
});
