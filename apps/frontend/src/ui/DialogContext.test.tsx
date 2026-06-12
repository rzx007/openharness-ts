import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { DialogProvider, useDialog } from "./DialogContext";
import { ThemeProvider } from "../theme/ThemeContext";

test("dialog renders above content when pushed and closes", async () => {
  let api: ReturnType<typeof useDialog> | null = null;

  function Capture() {
    api = useDialog();
    return null;
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } =
    await testRender(
      <ThemeProvider>
        <DialogProvider>
          <Capture />
          <text>base layer</text>
        </DialogProvider>
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();
  expect(captureCharFrame()).toContain("base layer");

  // Push a dialog
  await act(async () => {
    api!.push(<text>dialog content</text>);
  });
  await waitForFrame((f) => f.includes("dialog content"));
  expect(captureCharFrame()).toContain("dialog content");
  expect(api!.isOpen).toBe(true);

  // Close the dialog
  await act(async () => {
    api!.close();
  });
  await waitForFrame((f) => !f.includes("dialog content"));
  expect(captureCharFrame()).not.toContain("dialog content");
  expect(api!.isOpen).toBe(false);

  renderer.destroy();
});

test("dialog replace replaces entire stack", async () => {
  let api: ReturnType<typeof useDialog> | null = null;

  function Capture() {
    api = useDialog();
    return null;
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } =
    await testRender(
      <ThemeProvider>
        <DialogProvider>
          <Capture />
        </DialogProvider>
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();

  await act(async () => {
    api!.push(<text>first dialog</text>);
  });
  await waitForFrame((f) => f.includes("first dialog"));

  await act(async () => {
    api!.replace(<text>replacement dialog</text>);
  });
  await waitForFrame((f) => f.includes("replacement dialog"));
  expect(captureCharFrame()).not.toContain("first dialog");
  expect(captureCharFrame()).toContain("replacement dialog");

  renderer.destroy();
});

test("onClose callback is called when dialog closes", async () => {
  let api: ReturnType<typeof useDialog> | null = null;
  let closedCount = 0;

  function Capture() {
    api = useDialog();
    return null;
  }

  const { renderer, renderOnce, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <Capture />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    api!.push(<text>tracked dialog</text>, () => {
      closedCount++;
    });
  });
  await waitForFrame((f) => f.includes("tracked dialog"));

  await act(async () => {
    api!.close();
  });
  await waitForFrame((f) => !f.includes("tracked dialog"));
  expect(closedCount).toBe(1);

  renderer.destroy();
});

test("closeAll calls onClose for every stacked entry", async () => {
  let api: ReturnType<typeof useDialog> | null = null;
  let closedCount = 0;

  function Capture() {
    api = useDialog();
    return null;
  }

  const { renderer, renderOnce, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <Capture />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    api!.push(<text>d1</text>, () => {
      closedCount++;
    });
    api!.push(<text>d2</text>, () => {
      closedCount++;
    });
  });
  await waitForFrame((f) => f.includes("d2"));

  await act(async () => {
    api!.closeAll();
  });
  await waitForFrame((f) => !f.includes("d2"));
  expect(closedCount).toBe(2);
  expect(api!.isOpen).toBe(false);

  renderer.destroy();
});

test("esc key closes top dialog", async () => {
  let api: ReturnType<typeof useDialog> | null = null;

  function Capture() {
    api = useDialog();
    return null;
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame, mockInput } =
    await testRender(
      <ThemeProvider>
        <DialogProvider>
          <Capture />
          <text>background</text>
        </DialogProvider>
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();
  await act(async () => {
    api!.push(<text>esc-closeable dialog</text>);
  });
  await waitForFrame((f) => f.includes("esc-closeable dialog"));

  mockInput.pressEscape();
  // Give the native key parser and React scheduler time to process
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();
  expect(captureCharFrame()).not.toContain("esc-closeable dialog");

  renderer.destroy();
});
