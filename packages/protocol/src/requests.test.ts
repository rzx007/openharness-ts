import { describe, expect, it } from "vitest";

import {
  parseAdmitPromptRequest,
  parseCreateScheduledTaskRequest,
  parseCreateSessionRequest,
  parseReplyPermissionRequest,
  parseUpdateScheduledTaskRequest,
  parseUpdateSessionRequest,
  ProtocolValidationError,
} from "./requests.js";

function expectInvalid(run: () => unknown, field?: string): void {
  try {
    run();
    throw new Error("Expected request parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    expect((error as ProtocolValidationError).code).toBe("invalid_request");
    if (field) {
      expect((error as ProtocolValidationError).details).toEqual({ field });
    }
  }
}

describe("HTTP request parsers", () => {
  it("normalizes a session model into runtime metadata", () => {
    expect(
      parseCreateSessionRequest({
        id: "s1",
        cwd: "/repo",
        model: "fallback",
        metadata: { runtime: { model: "gpt-test" }, source: "desktop" },
      }),
    ).toEqual({
      id: "s1",
      cwd: "/repo",
      model: "gpt-test",
      metadata: { runtime: { model: "gpt-test" }, source: "desktop" },
    });
  });

  it("rejects invalid session fields instead of silently dropping them", () => {
    expectInvalid(
      () => parseCreateSessionRequest({ cwd: "/repo", model: "gpt-test", agent: 42 }),
      "agent",
    );
    expectInvalid(
      () => parseUpdateSessionRequest({ metadata: [] }),
      "metadata",
    );
    expectInvalid(
      () => parseUpdateSessionRequest({ model: "gpt-other" }),
      "model",
    );
  });

  it("accepts only the two supported prompt delivery modes", () => {
    expect(parseAdmitPromptRequest({ content: "hello", delivery: "steer" })).toEqual({
      content: "hello",
      delivery: "steer",
    });
    expectInvalid(
      () => parseAdmitPromptRequest({ content: "hello", delivery: "now" }),
      "delivery",
    );
  });

  it("validates permission replies", () => {
    expect(
      parseReplyPermissionRequest({
        status: "approved",
        decision: "session",
        clientId: "desktop",
      }),
    ).toEqual({ status: "approved", decision: "session", clientId: "desktop" });
    expectInvalid(
      () => parseReplyPermissionRequest({ status: "pending" }),
      "status",
    );
  });

  it("validates complete schedule requests and nested fields", () => {
    const parsed = parseCreateScheduledTaskRequest({
      name: "review",
      prompt: "Review changes",
      recurrence: "2026-08-23T09:00:00.000Z",
      recurrenceFormat: "once",
      timezone: "Asia/Shanghai",
      destination: "standalone",
      projectPaths: ["/repo"],
      permissionProfile: {
        mode: "workspace_write",
        network: false,
        allowedTools: ["read"],
      },
      stopPolicy: { maxRuns: 2 },
    });
    expect(parsed.permissionProfile).toEqual({
      mode: "workspace_write",
      network: false,
      allowedTools: ["read"],
    });
    expect(parsed.stopPolicy).toEqual({ maxRuns: 2 });

    expectInvalid(
      () => parseCreateScheduledTaskRequest({
        name: "review",
        prompt: "Review changes",
        recurrence: "tomorrow",
        recurrenceFormat: "later",
        timezone: "UTC",
        destination: "standalone",
      }),
      "recurrenceFormat",
    );
    expectInvalid(
      () => parseCreateScheduledTaskRequest({
        name: "review",
        prompt: "Review changes",
        recurrence: "tomorrow",
        recurrenceFormat: "once",
        timezone: "UTC",
        destination: "standalone",
        projectPaths: ["/repo", 1],
      }),
      "projectPaths",
    );
  });

  it("allows nullable schedule timestamps only on updates", () => {
    expect(parseUpdateScheduledTaskRequest({ nextRunAt: null, runCount: 0 })).toEqual({
      nextRunAt: null,
      runCount: 0,
    });
    expectInvalid(() => parseUpdateScheduledTaskRequest({ id: "replacement" }), "id");
  });
});
