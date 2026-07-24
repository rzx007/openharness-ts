import { describe, expect, it } from "vitest";
import { buildCodexHeaders, resolveCodexUrl } from "./codex";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("resolveCodexUrl", () => {
  it("defaults to chatgpt codex responses", () => {
    expect(resolveCodexUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("normalizes backend-api and codex URLs", () => {
    expect(resolveCodexUrl("https://chatgpt.com/backend-api")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
    expect(resolveCodexUrl("https://chatgpt.com/backend-api/codex")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });
});

describe("buildCodexHeaders", () => {
  it("extracts chatgpt account id from the access token", () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });
    const headers = buildCodexHeaders(token);
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
  });
});
