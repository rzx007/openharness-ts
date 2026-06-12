import { test, expect } from "bun:test";
import { buildRegistry } from "./commands";

test("merges backend slash commands with local commands", () => {
  const reg = buildRegistry({
    backendCommands: ["/help", "/theme"],
    local: [{ id: "app.exit", title: "Exit", keybinding: "ctrl+c", run: () => {} }],
    submitLine: () => {},
  });
  const ids = reg.all().map((c) => c.id);
  expect(ids).toContain("/help");
  expect(ids).toContain("app.exit");
});

test("backend command run() submits the slash line", () => {
  const lines: string[] = [];
  const reg = buildRegistry({ backendCommands: ["/help"], local: [], submitLine: (l) => lines.push(l) });
  reg.get("/help")!.run();
  expect(lines).toEqual(["/help"]);
});

test("slashCommands() only returns slash-prefixed entries", () => {
  const reg = buildRegistry({
    backendCommands: ["/help"],
    local: [{ id: "app.exit", title: "Exit", run: () => {} }],
    submitLine: () => {},
  });
  expect(reg.slashCommands().map((c) => c.id)).toEqual(["/help"]);
});

test("local command with same id overrides backend command", () => {
  const lines: string[] = [];
  let localRan = false;
  const reg = buildRegistry({
    backendCommands: ["/theme"],
    local: [{ id: "/theme", title: "Theme (local)", run: () => { localRan = true; } }],
    submitLine: (l) => lines.push(l),
  });
  expect(reg.all().filter((c) => c.id === "/theme")).toHaveLength(1);
  reg.get("/theme")!.run();
  expect(localRan).toBe(true);
  expect(lines).toEqual([]);
});
