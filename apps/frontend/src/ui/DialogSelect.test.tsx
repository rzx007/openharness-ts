import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { DialogSelect, type DialogSelectItem } from "./DialogSelect";
import { ThemeProvider } from "../theme/ThemeContext";

const sampleItems: DialogSelectItem[] = [
  { value: "theme", label: "/theme" },
  { value: "permissions", label: "/permissions" },
  { value: "plan", label: "/plan" },
  { value: "help", label: "/help" },
];

test("renders title and all item labels", async () => {
  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Select Command"
        items={sampleItems}
        onSelect={() => undefined}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("Select Command");
  expect(frame).toContain("/theme");
  expect(frame).toContain("/permissions");
  expect(frame).toContain("/plan");
  expect(frame).toContain("/help");

  renderer.destroy();
});

test("search narrows down to matching items", async () => {
  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      <ThemeProvider>
        <DialogSelect
          title="Select Command"
          items={sampleItems}
          onSelect={() => undefined}
        />
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();

  await act(async () => {
    await mockInput.typeText("/p");
  });
  await waitForFrame((f) => !f.includes("/theme"));

  const frame = captureCharFrame();
  expect(frame).toContain("/permissions");
  expect(frame).toContain("/plan");
  expect(frame).not.toContain("/theme");
  expect(frame).not.toContain("/help");

  renderer.destroy();
});

test("down arrow + enter triggers onSelect with correct value", async () => {
  let selected: string | undefined;

  const { renderer, renderOnce, mockInput } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Select Command"
        items={sampleItems}
        onSelect={(value) => {
          selected = value;
        }}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();

  mockInput.pressArrow("down");
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  mockInput.pressEnter();
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(selected).toBe("permissions");

  renderer.destroy();
});

test("mouse click selects the clicked item", async () => {
  let selected: string | undefined;

  const { renderer, renderOnce, mockMouse } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Select Command"
        items={sampleItems}
        onSelect={(value) => {
          selected = value;
        }}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await mockMouse.click(4, 4);
  await renderOnce();

  expect(selected).toBe("plan");

  renderer.destroy();
});

test("mouse wheel scrolls long option lists", async () => {
  const longItems: DialogSelectItem[] = Array.from({ length: 18 }, (_, index) => ({
    value: `item-${index}`,
    label: `Item ${index}`,
  }));

  const { renderer, renderOnce, waitForFrame, captureCharFrame, mockMouse } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Long List"
        items={longItems}
        searchable={false}
        onSelect={() => undefined}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  expect(captureCharFrame()).not.toContain("Item 17");

  for (let i = 0; i < 12; i += 1) {
    await mockMouse.scroll(4, 5, "down");
  }
  await renderOnce();
  await waitForFrame((frame) => frame.includes("Item 17"));

  expect(captureCharFrame()).toContain("Item 17");

  renderer.destroy();
});

test("active item shows checkmark prefix", async () => {
  const itemsWithActive: DialogSelectItem[] = [
    { value: "dark", label: "Dark Theme", active: true },
    { value: "light", label: "Light Theme", active: false },
  ];

  const { renderer, renderOnce, captureCharFrame } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Choose Theme"
        items={itemsWithActive}
        onSelect={() => undefined}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  const frame = captureCharFrame();
  expect(frame).toContain("✓");

  renderer.destroy();
});

test("empty filtered list shows no matches message", async () => {
  const { renderer, renderOnce, mockInput, waitForFrame, captureCharFrame } =
    await testRender(
      <ThemeProvider>
        <DialogSelect
          title="Select Command"
          items={sampleItems}
          onSelect={() => undefined}
        />
      </ThemeProvider>,
      { width: 80, height: 24 },
    );

  await renderOnce();

  await act(async () => {
    await mockInput.typeText("zzz");
  });
  await waitForFrame((f) => f.includes("no matches"));
  const frame = captureCharFrame();
  expect(frame).toContain("no matches");

  renderer.destroy();
});

test("digit shortcut works when searchable=false", async () => {
  let selected: string | undefined;

  const { renderer, renderOnce, mockInput } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Select"
        items={sampleItems}
        onSelect={(value) => {
          selected = value;
        }}
        searchable={false}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();

  mockInput.pressKey("2");
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(selected).toBe("permissions");

  renderer.destroy();
});

test("initialIndex preselects item and survives mount", async () => {
  let selected: string | undefined;
  const { renderer, renderOnce, mockInput } = await testRender(
    <ThemeProvider>
      <DialogSelect
        title="Mode"
        items={sampleItems}
        searchable={false}
        initialIndex={2}
        onSelect={(v) => (selected = v)}
      />
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    mockInput.pressEnter();
  });
  await new Promise((r) => setTimeout(r, 50));
  await renderOnce();

  expect(selected).toBe("plan");
  renderer.destroy();
});
