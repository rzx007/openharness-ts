import { describe, expect, it } from "vitest";

import { resolveDaemonInvocation } from "./daemon-process.js";

describe("resolveDaemonInvocation", () => {
  it("uses Node with tsx for a TypeScript CLI launched by Bun", () => {
    expect(resolveDaemonInvocation("D:/repo/apps/cli/src/index.ts", ["serve"], {
      bunRuntime: true,
      nodePath: "node.exe",
      tsxImport: "file:///D:/repo/node_modules/tsx/dist/loader.mjs",
    })).toEqual({
      command: "node.exe",
      args: [
        "--import",
        "file:///D:/repo/node_modules/tsx/dist/loader.mjs",
        "D:/repo/apps/cli/src/index.ts",
        "serve",
      ],
    });
  });

  it("uses Node directly for a bundled JavaScript CLI launched by Bun", () => {
    expect(resolveDaemonInvocation("D:/repo/apps/cli/dist/index.js", ["serve"], {
      bunRuntime: true,
      nodePath: "node.exe",
    })).toEqual({
      command: "node.exe",
      args: ["D:/repo/apps/cli/dist/index.js", "serve"],
    });
  });

  it("resolves an absolute Node path for a long-running daemon launched from Bun", () => {
    expect(resolveDaemonInvocation("D:/repo/apps/cli/dist/index.js", ["serve"], {
      bunRuntime: true,
      locateNode: () => "D:/node/node.exe",
    })).toEqual({
      command: "D:/node/node.exe",
      args: ["D:/repo/apps/cli/dist/index.js", "serve"],
    });
  });

  it("uses the current Node executable for a bundled CLI", () => {
    expect(resolveDaemonInvocation("/repo/apps/cli/dist/index.js", ["serve"], {
      bunRuntime: false,
      execPath: "/usr/bin/node",
    })).toEqual({
      command: "/usr/bin/node",
      args: ["/repo/apps/cli/dist/index.js", "serve"],
    });
  });
});
