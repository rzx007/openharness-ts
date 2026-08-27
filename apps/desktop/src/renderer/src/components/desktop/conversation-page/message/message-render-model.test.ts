import { describe, expect, it } from "vitest"

import type { DesktopSessionPart } from "@shared/session-types"

import {
  buildAssistantContent,
  collectChangedFiles,
  parseFileReference,
  parseInlineFileReference,
} from "./message-render-model"

describe("message render model", () => {
  it("preserves commentary and final-answer phase metadata", () => {
    const part = {
      ...toolPart("Read", {}),
      type: "text" as const,
      text: "I will inspect it.",
      metadata: { phase: "commentary" },
    }

    expect(buildAssistantContent([part])).toEqual([
      {
        id: "part-1",
        type: "markdown",
        text: "I will inspect it.",
        phase: "commentary",
      },
    ])
  })

  it("recognizes project files but rejects web links", () => {
    expect(parseFileReference("apps/desktop/src/App.tsx:42")).toEqual({
      path: "apps/desktop/src/App.tsx",
      line: 42,
    })
    expect(parseFileReference("https://example.com/App.tsx")).toBeNull()
  })

  it("keeps inline file references conservative", () => {
    expect(parseInlineFileReference("assistant-message.tsx")).toBeNull()
    expect(parseInlineFileReference("shiki/engine/javascript")).toBeNull()
    expect(parseInlineFileReference("apps/desktop/src/App.tsx:42")).toEqual({
      path: "apps/desktop/src/App.tsx",
      line: 42,
    })
    expect(parseInlineFileReference("./Dockerfile")).toEqual({ path: "./Dockerfile" })
  })

  it("rejects inline dependency and generated paths across common project types", () => {
    expect(parseInlineFileReference("node_modules/react/index.js")).toBeNull()
    expect(parseInlineFileReference("packages/foo/node_modules/bar/index.js")).toBeNull()
    expect(parseInlineFileReference(".pnpm/react@19/node_modules/react/index.js")).toBeNull()
    expect(parseInlineFileReference("dist/index.js")).toBeNull()
    expect(parseInlineFileReference("build/classes/java/main/App.class")).toBeNull()
    expect(
      parseInlineFileReference(".venv/lib/python3.12/site-packages/django/__init__.py")
    ).toBeNull()
    expect(parseInlineFileReference("__pycache__/foo.cpython-312.pyc")).toBeNull()
    expect(parseInlineFileReference("target/debug/build/foo/out/bindings.rs")).toBeNull()
    expect(
      parseInlineFileReference(".cargo/registry/src/index.crates.io/foo/src/lib.rs")
    ).toBeNull()
    expect(
      parseInlineFileReference("pkg/mod/github.com/gin-gonic/gin@v1.10.0/context.go")
    ).toBeNull()
    expect(parseInlineFileReference("vendor/bundle/ruby/3.3.0/gems/rails/lib/rails.rb")).toBeNull()
    expect(parseInlineFileReference("vendor/autoload.php")).toBeNull()
    expect(parseInlineFileReference(".gradle/caches/modules-2/files-2.1/App.java")).toBeNull()
    expect(parseInlineFileReference("obj/Debug/net8.0/Foo.AssemblyInfo.cs")).toBeNull()
  })

  it("keeps inline source files clickable across common project types", () => {
    expect(parseInlineFileReference("src/index.ts")).toEqual({ path: "src/index.ts" })
    expect(parseInlineFileReference("cmd/server/main.go")).toEqual({ path: "cmd/server/main.go" })
    expect(parseInlineFileReference("crates/core/src/lib.rs")).toEqual({
      path: "crates/core/src/lib.rs",
    })
    expect(parseInlineFileReference("app/models/user.py")).toEqual({ path: "app/models/user.py" })
    expect(parseInlineFileReference("src/main/java/com/example/App.java")).toEqual({
      path: "src/main/java/com/example/App.java",
    })
    expect(parseInlineFileReference(".vscode/settings.json")).toEqual({
      path: ".vscode/settings.json",
    })
  })

  it("collects files and line stats from an apply patch call", () => {
    const part = toolPart("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/App.tsx",
        "-const oldValue = true",
        "+const newValue = true",
        "+const enabled = true",
        "*** Add File: src/new-file.ts",
        "+export const value = 1",
        "*** End Patch",
      ].join("\n"),
    })

    expect(collectChangedFiles([part])).toEqual([
      { path: "src/App.tsx", additions: 2, deletions: 1, hasStats: true },
      { path: "src/new-file.ts", additions: 1, deletions: 0, hasStats: true },
    ])
  })

  it("collects a structured path from a write tool", () => {
    expect(collectChangedFiles([toolPart("write_file", { file_path: "src/output.ts" })])).toEqual([
      { path: "src/output.ts", additions: 0, deletions: 0, hasStats: false },
    ])
  })
})

function toolPart(toolName: string, input: Record<string, unknown>): DesktopSessionPart {
  return {
    id: "part-1",
    sessionId: "session-1",
    messageId: "message-1",
    seq: 1,
    type: "tool",
    status: "completed",
    toolName,
    input,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  }
}
