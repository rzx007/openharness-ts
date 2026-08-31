import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { ContextResourceError } from "../../../application/context/context-resource-error.js";
import { createContextRoutes } from "../context.js";

function fixture(overrides: Record<string, unknown> = {}, blocked = false) {
  const service = {
    list: vi.fn(async () => [{ id: "ctx-1", scope: "user", kind: "user_preference", title: "简洁", content: "回答简洁。" }]),
    get: vi.fn(async () => ({ id: "ctx-1" })), add: vi.fn(async () => ({ status: "completed", results: [] })),
    update: vi.fn(), remove: vi.fn(), candidates: vi.fn(async () => []), accept: vi.fn(), reject: vi.fn(),
    status: vi.fn(async () => ({ enabled: true, active: 1, candidates: 0, byScope: {}, byKind: {} })),
    preview: vi.fn(async () => ({ content: "preview" })), ...overrides,
  };
  const app = new Hono().route("/context", createContextRoutes({
    service: service as never,
    control: { acquireCwdMutation: () => blocked ? undefined : { release: vi.fn() } },
  }));
  return { app, service };
}

describe("context routes", () => {
  it("lists logical entries without storage paths and validates scope", async () => {
    const { app, service } = fixture();
    const response = await app.request("/context/entries?cwd=C%3A%5Crepo&scope=user");
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/(?:directory|path)/iu);
    expect(service.list).toHaveBeenCalledWith({ cwd: "C:\\repo", scope: "user" });
    expect((await app.request("/context/entries?cwd=x&scope=bad")).status).toBe(400);
  });

  it("maps missing entries, secrets, and active-cwd conflicts", async () => {
    const missing = fixture({ get: vi.fn(async () => { throw new ContextResourceError("not_found", "missing"); }) });
    expect((await missing.app.request("/context/entries/nope?cwd=x")).status).toBe(404);

    const secret = fixture({ add: vi.fn(async () => { throw new ContextResourceError("secret", "secret"); }) });
    expect((await secret.app.request("/context/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "x", content: "token" }) })).status).toBe(422);

    const blocked = fixture({}, true);
    expect((await blocked.app.request("/context/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "x", content: "remember" }) })).status).toBe(409);
  });
});
