import { expect, test } from "bun:test";
import { copySelectionToClipboard } from "./selection";

function createRenderer(text?: string) {
  const calls: string[] = [];
  return {
    calls,
    renderer: {
      getSelection: () =>
        text === undefined
          ? null
          : {
              getSelectedText: () => text,
            },
      copyToClipboardOSC52: (value: string) => {
        calls.push(`osc52:${value}`);
        return true;
      },
      clearSelection: () => {
        calls.push("clear");
      },
    },
  };
}

test("copySelectionToClipboard copies and clears a non-empty selection", async () => {
  const { calls, renderer } = createRenderer("hello selection");
  const toasts: string[] = [];
  const copied: string[] = [];

  const handled = copySelectionToClipboard(
    renderer,
    (message) => toasts.push(message),
    async (text) => {
      copied.push(text);
    },
  );

  await Promise.resolve();

  expect(handled).toBe(true);
  expect(copied).toEqual(["hello selection"]);
  expect(calls).toEqual(["osc52:hello selection", "clear"]);
  expect(toasts).toEqual(["Copied to clipboard"]);
});

test("copySelectionToClipboard ignores missing selection", async () => {
  const missing = createRenderer();

  expect(
    copySelectionToClipboard(missing.renderer, () => undefined, async () => undefined),
  ).toBe(false);

  expect(missing.calls).toEqual([]);
});

test("copySelectionToClipboard clears empty selection without exiting", async () => {
  const empty = createRenderer("");

  expect(
    copySelectionToClipboard(empty.renderer, () => undefined, async () => undefined),
  ).toBe(true);

  expect(empty.calls).toEqual(["clear"]);
});
