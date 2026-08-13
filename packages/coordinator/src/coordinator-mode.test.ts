import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSimpleMode,
  matchSessionMode,
  getCoordinatorTools,
  getCoordinatorUserContext,
  getCoordinatorSystemPrompt,
} from "./coordinator-mode.js";

beforeEach(() => {
  delete process.env.OPENHARNESS_COORDINATOR_MODE;
  delete process.env.OPENHARNESS_COORDINATOR_SIMPLE;
});

afterEach(() => {
  delete process.env.OPENHARNESS_COORDINATOR_MODE;
  delete process.env.OPENHARNESS_COORDINATOR_SIMPLE;
});

describe("matchSessionMode", () => {
  it("returns undefined when modes already match or no session mode", () => {
    expect(matchSessionMode(undefined)).toBeUndefined();
    expect(matchSessionMode("normal")).toBeUndefined(); // both non-coordinator
    process.env.OPENHARNESS_COORDINATOR_MODE = "1";
    expect(matchSessionMode("coordinator")).toBeUndefined();
  });

  it("enters coordinator mode to match a resumed coordinator session", () => {
    const warning = matchSessionMode("coordinator");
    expect(warning).toContain("Entered coordinator mode");
    expect(process.env.OPENHARNESS_COORDINATOR_MODE).toBe("1");
  });

  it("exits coordinator mode to match a resumed normal session", () => {
    process.env.OPENHARNESS_COORDINATOR_MODE = "true";
    const warning = matchSessionMode("normal");
    expect(warning).toContain("Exited coordinator mode");
    expect(process.env.OPENHARNESS_COORDINATOR_MODE).toBeUndefined();
  });
});

describe("getCoordinatorTools", () => {
  it("reserves orchestration tools for the coordinator", () => {
    expect(getCoordinatorTools()).toEqual(["Agent", "SendMessage", "TaskStop", "TaskWait", "Workflow"]);
  });
});

describe("getCoordinatorUserContext", () => {
  it("returns {} outside coordinator mode", () => {
    expect(getCoordinatorUserContext()).toEqual({});
  });

  it("can be enabled explicitly by a session-owned host", () => {
    const ctx = getCoordinatorUserContext([{ name: "db" }], undefined, { enabled: true });
    expect(ctx.workerToolsContext).toContain("MCP servers: db");
  });

  it("lists worker tools, MCP servers, and scratchpad when provided", () => {
    process.env.OPENHARNESS_COORDINATOR_MODE = "1";
    const ctx = getCoordinatorUserContext([{ name: "db" }, { name: "web" }], "/tmp/pad");
    const content = ctx.workerToolsContext!;
    expect(content).toContain("Bash");
    expect(content).toContain("Skill");
    expect(content).toContain("MCP servers: db, web");
    expect(content).toContain("Scratchpad directory: /tmp/pad");
  });

  it("simple mode narrows the worker tool list", () => {
    process.env.OPENHARNESS_COORDINATOR_MODE = "1";
    process.env.OPENHARNESS_COORDINATOR_SIMPLE = "true";
    expect(isSimpleMode()).toBe(true);
    const content = getCoordinatorUserContext().workerToolsContext!;
    expect(content).toContain("Bash, Edit, Read");
    expect(content).not.toContain("WebSearch");
  });
});

describe("getCoordinatorSystemPrompt", () => {
  it("RICH_CAPABILITIES stays in sync with the static prompt (replace guard)", async () => {
    const { COORDINATOR_SYSTEM_PROMPT } = await import("./index.js");
    const { RICH_CAPABILITIES } = await import("./coordinator-mode.js");
    expect(COORDINATOR_SYSTEM_PROMPT).toContain(RICH_CAPABILITIES);
  });

  it("uses the rich worker capabilities by default", () => {
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("project skills via the Skill tool");
    expect(prompt).toContain("Workflow");
    expect(prompt).toContain("## 1. Your Role");
  });

  it("swaps in the simple capabilities under OPENHARNESS_COORDINATOR_SIMPLE", () => {
    process.env.OPENHARNESS_COORDINATOR_SIMPLE = "1";
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("Workers have access to Bash, Read, and Edit tools");
    expect(prompt).not.toContain("project skills via the Skill tool");
  });
});
