import { describe, expect, it } from "vitest";

import type {
  SessionEventRecord,
  SessionStateSnapshot,
} from "./session.js";
import {
  decodeJobSnapshot,
  decodeSessionStateSnapshot,
  decodeTerminalEvent,
  decodeTerminalSessionInfo,
  deserializeSessionEventRecord,
  deserializeSessionStateSnapshot,
  ProtocolDataError,
  serializeSessionEventRecord,
  serializeSessionStateSnapshot,
} from "./serialization.js";

const snapshot: SessionStateSnapshot = {
  cursor: 7,
  session: {
    id: "s1",
    cwd: "/repo",
    title: "Review",
    model: "gpt-test",
    status: "idle",
    metadata: { runtime: { model: "gpt-test" } },
    createdAt: 1,
    updatedAt: 2,
  },
  inputs: [
    {
      id: "i1",
      sessionId: "s1",
      seq: 1,
      delivery: "queue",
      content: "Review this",
      metadata: {},
      createdAt: 2,
    },
  ],
  messages: [],
  parts: [],
  runs: [],
  attempts: [],
  tasks: [],
  permissions: [],
};

const event: SessionEventRecord = {
  id: "e1",
  seq: 7,
  type: "session.updated",
  schemaVersion: 1,
  sessionId: "s1",
  payload: { title: "Review" },
  createdAt: 3,
};

describe("protocol serialization", () => {
  it("round-trips a Session snapshot through JSON", () => {
    const text = serializeSessionStateSnapshot(snapshot);
    expect(deserializeSessionStateSnapshot(text)).toEqual(snapshot);
  });

  it("round-trips a Session event envelope through JSON", () => {
    const text = serializeSessionEventRecord(event);
    expect(deserializeSessionEventRecord(text)).toEqual(event);
  });

  it("reports the exact path of malformed snapshot data", () => {
    expect(() =>
      decodeSessionStateSnapshot({
        ...snapshot,
        inputs: [{ ...snapshot.inputs[0], seq: "first" }],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProtocolDataError>>({
        code: "invalid_protocol_data",
        details: { path: "snapshot.inputs[0].seq" },
      }),
    );
  });

  it("rejects malformed JSON before reading an event", () => {
    expect(() => deserializeSessionEventRecord("{")).toThrow(
      "Protocol data must be valid JSON",
    );
  });

  it("decodes portable Job and Terminal responses", () => {
    expect(
      decodeJobSnapshot({
        id: "job-1",
        kind: "shell",
        label: "tests",
        ownerSession: "s1",
        status: "running",
        capabilities: { read: true, wait: true, send: false, cancel: true },
        cwd: "/repo",
        startedAt: 1,
        updatedAt: 2,
      }).id,
    ).toBe("job-1");

    expect(
      decodeTerminalSessionInfo({
        id: "terminal-1",
        name: "Terminal",
        projectId: "p1",
        runtime: "local",
        source: "user",
        status: "running",
        cwd: "/repo",
        shell: "pwsh",
        cols: 120,
        rows: 30,
        createdAt: "2026-08-22T00:00:00.000Z",
      }).id,
    ).toBe("terminal-1");

    expect(
      decodeTerminalEvent({
        type: "data",
        terminalId: "terminal-1",
        data: "ok",
        sequence: 1,
      }),
    ).toEqual({
      type: "data",
      terminalId: "terminal-1",
      data: "ok",
      sequence: 1,
    });
  });
});
