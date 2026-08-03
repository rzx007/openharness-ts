import { expect, test } from "bun:test";
import { assertSupportedTuiRuntime, MIN_WINDOWS_BUN_VERSION } from "./runtime";

test("rejects outdated Bun before OpenTUI can load on Windows", () => {
  expect(() => assertSupportedTuiRuntime({ platform: "win32", bunVersion: "1.3.10" }))
    .toThrow(`Bun ${MIN_WINDOWS_BUN_VERSION} or newer`);
});

test("accepts supported Bun versions and other runtimes", () => {
  expect(() => assertSupportedTuiRuntime({ platform: "win32", bunVersion: MIN_WINDOWS_BUN_VERSION }))
    .not.toThrow();
  expect(() => assertSupportedTuiRuntime({ platform: "linux", bunVersion: "1.0.0" }))
    .not.toThrow();
  expect(() => assertSupportedTuiRuntime({ platform: "win32", bunVersion: null }))
    .not.toThrow();
});
