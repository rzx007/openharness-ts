import { test, expect } from "bun:test";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../../theme/ThemeContext";
import { Autocomplete } from "./Autocomplete";
import type { AutocompleteItem } from "./Autocomplete";

test("Autocomplete renders items with two-column layout", async () => {
  const items: AutocompleteItem[] = [
    { id: "/clear", label: "/clear", detail: "Clear the transcript" },
    { id: "/new", label: "/new", detail: "Start a new conversation" },
    { id: "/help", label: "/help" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={60} height={10}>
        <Autocomplete items={items} selectedIndex={0} />
      </box>
    </ThemeProvider>,
    { width: 60, height: 10 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("/clear");
  expect(frame).toContain("Clear the transcript");
  expect(frame).toContain("/new");
  expect(frame).toContain("/help");

  renderer.destroy();
});

test("Autocomplete highlights selected row", async () => {
  const items: AutocompleteItem[] = [
    { id: "/a", label: "/a" },
    { id: "/b", label: "/b" },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <box width={40} height={5}>
        <Autocomplete items={items} selectedIndex={1} />
      </box>
    </ThemeProvider>,
    { width: 40, height: 5 },
  );

  await renderOnce();
  const frame = captureCharFrame();

  expect(frame).toContain("/a");
  expect(frame).toContain("/b");

  renderer.destroy();
});
