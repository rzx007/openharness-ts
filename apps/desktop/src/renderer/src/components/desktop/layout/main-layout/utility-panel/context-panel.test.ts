import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ContextPanel } from "./context-panel";

describe("ContextPanel", () => {
  it("offers active, candidate and preview views without rendering storage paths", () => {
    const html = renderToStaticMarkup(
      createElement(ContextPanel, { cwd: "D:/project" }),
    );
    expect(html).toContain("已保存");
    expect(html).toContain("待确认");
    expect(html).toContain("注入预览");
    expect(html).not.toMatch(/storagePath|context\//i);
  });

  it("explains that a working directory is required", () => {
    const html = renderToStaticMarkup(
      createElement(ContextPanel, { cwd: null }),
    );
    expect(html).toContain("尚未选择工作目录");
  });
});
