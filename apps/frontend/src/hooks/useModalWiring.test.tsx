import { expect, test } from "bun:test";
import React, { useMemo, useState } from "react";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { ThemeProvider } from "../theme/ThemeContext";
import { DialogProvider, useDialog } from "../ui/DialogContext";
import { useModalWiring } from "./useModalWiring";
import type { TuiSessionController } from "./sessionController";

function SelectHarness(props: {
  onReady: (api: {
    setSelectRequest: TuiSessionController["setSelectRequest"];
    sent: Array<Record<string, unknown>>;
  }) => void;
}) {
  const dialog = useDialog();
  const [selectRequest, setSelectRequest] = useState<TuiSessionController["selectRequest"]>(null);
  const sent: Array<Record<string, unknown>> = useMemo(() => [], []);
  const session = useMemo<TuiSessionController>(() => ({
    transcript: [],
    assistantBuffer: "",
    status: {},
    tasks: [],
    commands: [],
    commandDetails: [],
    mcpServers: [],
    bridgeSessions: [],
    modal: null,
    selectRequest,
    displayRequest: null,
    busy: false,
    ready: true,
    todoMarkdown: "",
    swarmTeammates: [],
    swarmNotifications: [],
    workflowState: null,
    setModal: () => undefined,
    setSelectRequest,
    setDisplayRequest: () => undefined,
    setBusy: () => undefined,
    sendRequest: (payload) => {
      sent.push(payload);
    },
  }), [selectRequest, sent]);

  useModalWiring(session, dialog);
  props.onReady({ setSelectRequest, sent });
  return null;
}

test("updating /sessions options does not close the picker", async () => {
  let api: {
    setSelectRequest: TuiSessionController["setSelectRequest"];
    sent: Array<Record<string, unknown>>;
  } | null = null;

  const { renderer, renderOnce, captureCharFrame, waitForFrame } = await testRender(
    <ThemeProvider>
      <DialogProvider>
        <SelectHarness onReady={(next) => { api = next; }} />
      </DialogProvider>
    </ThemeProvider>,
    { width: 80, height: 24 },
  );

  await renderOnce();
  await act(async () => {
    api?.setSelectRequest({
      title: "Sessions",
      submitPrefix: "/sessions open ",
      options: [
        { value: "s1", label: "One" },
        { value: "s2", label: "Two" },
      ],
    });
  });
  await waitForFrame((f) => f.includes("Two"));

  await act(async () => {
    api?.setSelectRequest({
      title: "Sessions",
      submitPrefix: "/sessions open ",
      options: [{ value: "s1", label: "One" }],
    });
  });
  await waitForFrame((f) => !f.includes("Two"));
  const frame = captureCharFrame();
  expect(frame).toContain("Sessions");
  expect(frame).toContain("One");
  expect(frame).not.toContain("Two");

  renderer.destroy();
});
