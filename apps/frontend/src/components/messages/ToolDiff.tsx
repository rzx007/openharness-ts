import React from "react";
import { createTwoFilesPatch } from "diff";
import type { SyntaxStyle } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";

const MAX_PATCH_LINES = 20;

function filetypeFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    sh: "bash",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? map[ext] : undefined;
}

export function truncatePatch(patch: string, maxLines = MAX_PATCH_LINES): string {
  const lines = patch.split("\n");
  if (lines.length <= maxLines) return patch;
  const kept = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  kept.push(`… +${remaining} more lines`);
  return kept.join("\n");
}

export type ToolDiffProps = {
  filePath: string;
  oldText: string;
  newText: string;
  syntaxStyle?: SyntaxStyle;
};

export function ToolDiff({ filePath, oldText, newText, syntaxStyle }: ToolDiffProps) {
  const { theme } = useTheme();
  const c = theme.colors;

  const rawPatch = createTwoFilesPatch(filePath, filePath, oldText, newText, "", "");
  const patch = truncatePatch(rawPatch);
  const filetype = filetypeFromPath(filePath);

  return (
    <diff
      diff={patch}
      view="unified"
      showLineNumbers={true}
      filetype={filetype}
      syntaxStyle={syntaxStyle}
      addedBg={c.success}
      removedBg={c.error}
    />
  );
}
