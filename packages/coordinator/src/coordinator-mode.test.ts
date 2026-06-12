import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSimpleMode,
  matchSessionMode,
  getCoordinatorTools,
  getCoordinatorUserContext,
  getCoordinatorSystemPrompt,
} from "./coordinator-mode.js";

beforeEach(() => {
  delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
  delete process.env.CLAUDE_CODE_SIMPLE;
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_COORDINATOR_MODE;
  delete process.env.CLAUDE_CODE_SIMPLE;
});

describe("matchSessionMode", () => {
  it("returns undefined when modes already match or no session mode", () => {
    expect(matchSessionMode(undefined)).toBeUndefined();
    expect(matchSessionMode("normal")).toBeUndefined(); // both non-coordinator
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "1";
    expect(matchSessionMode("coordinator")).toBeUndefined();
  });

  it("enters coordinator mode to match a resumed coordinator session", () => {
    const warning = matchSessionMode("coordinator");
    expect(warning).toContain("Entered coordinator mode");
    expect(process.env.CLAUDE_CODE_COORDINATOR_MODE).toBe("1");
  });

  it("exits coordinator mode to match a resumed normal session", () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "true";
    const warning = matchSessionMode("normal");
    expect(warning).toContain("Exited coordinator mode");
    expect(process.env.CLAUDE_CODE_COORDINATOR_MODE).toBeUndefined();
  });
});

describe("getCoordinatorTools", () => {
  it("reserves Agent / SendMessage / TaskStop for the coordinator", () => {
    expect(getCoordinatorTools()).toEqual(["Agent", "SendMessage", "TaskStop"]);
  });
});

describe("getCoordinatorUserContext", () => {
  it("returns {} outside coordinator mode", () => {
    expect(getCoordinatorUserContext()).toEqual({});
  });

  it("lists worker tools, MCP servers, and scratchpad when provided", () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "1";
    const ctx = getCoordinatorUserContext([{ name: "db" }, { name: "web" }], "/tmp/pad");
    const content = ctx.workerToolsContext!;
    expect(content).toContain("Bash");
    expect(content).toContain("Skill");
    expect(content).toContain("MCP servers: db, web");
    expect(content).toContain("Scratchpad directory: /tmp/pad");
  });

  it("simple mode narrows the worker tool list", () => {
    process.env.CLAUDE_CODE_COORDINATOR_MODE = "1";
    process.env.CLAUDE_CODE_SIMPLE = "true";
    expect(isSimpleMode()).toBe(true);
    const content = getCoordinatorUserContext().workerToolsContext!;
    expect(content).toContain("Bash, Edit, Read");
    expect(content).not.toContain("WebSearch");
  });
});

describe("getCoordinatorSystemPrompt", () => {
  it("uses the rich worker capabilities by default", () => {
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("project skills via the Skill tool");
    expect(prompt).toContain("## 1. Your Role");
  });

  it("swaps in the simple capabilities under CLAUDE_CODE_SIMPLE", () => {
    process.env.CLAUDE_CODE_SIMPLE = "1";
    const prompt = getCoordinatorSystemPrompt();
    expect(prompt).toContain("Workers have access to Bash, Read, and Edit tools");
    expect(prompt).not.toContain("project skills via the Skill tool");
  });
});
