import { test, expect } from "bun:test";
import React from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ToastProvider, useToast } from "./Toast";
import { ThemeProvider } from "../theme/ThemeContext";

test("toast appears in frame after toast()", async () => {
  let toastApi: ReturnType<typeof useToast> | null = null;

  function Capture(): React.ReactNode {
    toastApi = useToast();
    return null;
  }

  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider>
      <ToastProvider>
        <Capture />
      </ToastProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    toastApi!.toast("hello toast");
  });
  await waitForFrame((f) => f.includes("hello toast"));
  expect(captureCharFrame()).toContain("hello toast");

  renderer.destroy();
});

test("toast disappears after ttl expires", async () => {
  let toastApi: ReturnType<typeof useToast> | null = null;

  function Capture(): React.ReactNode {
    toastApi = useToast();
    return null;
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } =
    await testRender(
      <ThemeProvider>
        <ToastProvider>
          <Capture />
        </ToastProvider>
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();
  await act(async () => {
    toastApi!.toast("short-lived toast", "info", 80);
  });
  await waitForFrame((f) => f.includes("short-lived toast"));

  // Wait for TTL to expire, then wait for it to disappear
  await new Promise((r) => setTimeout(r, 150));
  await waitForFrame((f) => !f.includes("short-lived toast"), {
    maxPasses: 50,
  });
  expect(captureCharFrame()).not.toContain("short-lived toast");

  renderer.destroy();
});

test("error toast uses error level (renders without crashing)", async () => {
  let toastApi: ReturnType<typeof useToast> | null = null;

  function Capture(): React.ReactNode {
    toastApi = useToast();
    return null;
  }

  const { renderer, renderOnce, waitForFrame, captureCharFrame } = await testRender(
    <ThemeProvider>
      <ToastProvider>
        <Capture />
      </ToastProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    toastApi!.toast("error occurred", "error", 5000);
  });
  await waitForFrame((f) => f.includes("error occurred"));

  renderer.destroy();
});

test("multiple toasts are stacked", async () => {
  let toastApi: ReturnType<typeof useToast> | null = null;

  function Capture(): React.ReactNode {
    toastApi = useToast();
    return null;
  }

  const { renderer, renderOnce, captureCharFrame, waitForFrame } =
    await testRender(
      <ThemeProvider>
        <ToastProvider>
          <Capture />
        </ToastProvider>
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();
  await act(async () => {
    toastApi!.toast("first message", "info", 5000);
    toastApi!.toast("second message", "info", 5000);
  });
  await waitForFrame(
    (f) => f.includes("first message") && f.includes("second message"),
  );
  const frame = captureCharFrame();
  expect(frame).toContain("first message");
  expect(frame).toContain("second message");

  renderer.destroy();
});
