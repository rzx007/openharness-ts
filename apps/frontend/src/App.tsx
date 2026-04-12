import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";

import { CommandPicker } from "./components/CommandPicker";
import { ConversationView } from "./components/ConversationView";
import { ModalHost } from "./components/ModalHost";
import { PromptInput } from "./components/PromptInput";
import { SelectModal, type SelectOption } from "./components/SelectModal";
import { StatusBar } from "./components/StatusBar";
import { SwarmPanel } from "./components/SwarmPanel";
import { TodoPanel } from "./components/TodoPanel";
import { useBackendSession } from "./hooks/useBackendSession";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import type { FrontendConfig } from "./types";

const PERMISSION_MODES: SelectOption[] = [
  { value: "default", label: "Default", description: "Ask before write/execute operations" },
  { value: "full_auto", label: "Auto", description: "Allow all tools automatically" },
  { value: "plan", label: "Plan Mode", description: "Block all write operations" },
];

type SelectModalState = {
  title: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
} | null;

export function App({ config }: { config: FrontendConfig & { theme?: string } }): React.JSX.Element {
  const initialTheme = String((config as Record<string, unknown>).theme ?? "default");
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <AppInner config={config} />
    </ThemeProvider>
  );
}

function AppInner({ config }: { config: FrontendConfig }): React.JSX.Element {
  const { exit } = useApp();
  const { theme, setThemeName } = useTheme();
  const [input, setInput] = useState("");
  const [modalInput, setModalInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [selectModal, setSelectModal] = useState<SelectModalState>(null);
  const [selectIndex, setSelectIndex] = useState(0);
  const session = useBackendSession(config, () => exit());

  const currentToolName = useMemo(() => {
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      const item = session.transcript[i]!;
      if (item.role === "tool") return item.tool_name ?? "tool";
      if (item.role === "tool_result" || item.role === "assistant") break;
    }
    return undefined;
  }, [session.transcript]);

  const commandHints = useMemo(() => {
    const value = input.trim();
    if (!value.startsWith("/")) return [] as string[];
    return session.commands.filter((cmd) => cmd.startsWith(value)).slice(0, 10);
  }, [session.commands, input]);

  const showPicker = commandHints.length > 0 && !session.busy && !session.modal && !selectModal;

  useEffect(() => {
    setPickerIndex(0);
  }, [commandHints.length, input]);

  useEffect(() => {
    if (!session.selectRequest) return;
    const req = session.selectRequest;
    if (req.options.length === 0) {
      session.setSelectRequest(null);
      return;
    }
    setSelectIndex(0);
    setSelectModal({
      title: req.title,
      options: req.options.map((o) => ({ value: o.value, label: o.label, description: o.description })),
      onSelect: (value) => {
        session.sendRequest({ type: "submit_line", line: `${req.submitPrefix}${value}` });
        session.setBusy(true);
        setSelectModal(null);
      },
    });
    session.setSelectRequest(null);
  }, [session.selectRequest]);

  const handleCommand = (cmd: string): boolean => {
    const trimmed = cmd.trim();

    const themeMatch = /^\/theme\s+set\s+(\S+)$/.exec(trimmed);
    if (themeMatch && themeMatch[1]) {
      setThemeName(themeMatch[1]);
      return true;
    }

    if (trimmed === "/permissions" || trimmed === "/permissions show") {
      const currentMode = String(session.status.permission_mode ?? "default");
      const options = PERMISSION_MODES.map((opt) => ({
        ...opt,
        active: opt.value === currentMode,
      }));
      const initialIdx = options.findIndex((o) => o.active);
      setSelectIndex(initialIdx >= 0 ? initialIdx : 0);
      setSelectModal({
        title: "Permission Mode",
        options,
        onSelect: (value) => {
          session.sendRequest({ type: "submit_line", line: `/permissions set ${value}` });
          session.setBusy(true);
          setSelectModal(null);
        },
      });
      return true;
    }

    if (trimmed === "/plan") {
      const currentMode = String(session.status.permission_mode ?? "default");
      if (currentMode === "plan") {
        session.sendRequest({ type: "submit_line", line: "/plan off" });
      } else {
        session.sendRequest({ type: "submit_line", line: "/plan on" });
      }
      session.setBusy(true);
      return true;
    }

    if (trimmed === "/resume") {
      session.sendRequest({ type: "list_sessions" });
      return true;
    }

    return false;
  };

  useInput((chunk, key) => {
    if (key.ctrl && chunk === "c") {
      session.sendRequest({ type: "shutdown" });
      exit();
      return;
    }

    if (selectModal) {
      if (key.upArrow) {
        setSelectIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectIndex((i) => Math.min(selectModal.options.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const selected = selectModal.options[selectIndex];
        if (selected) selectModal.onSelect(selected.value);
        return;
      }
      if (key.escape) {
        setSelectModal(null);
        return;
      }
      const num = parseInt(chunk, 10);
      if (num >= 1 && num <= selectModal.options.length) {
        const selected = selectModal.options[num - 1];
        if (selected) selectModal.onSelect(selected.value);
        return;
      }
      return;
    }

    if (session.modal?.kind === "permission") {
      if (chunk.toLowerCase() === "y") {
        session.sendRequest({
          type: "permission_response",
          request_id: session.modal.request_id as string,
          allowed: true,
        });
        session.setModal(null);
        return;
      }
      if (chunk.toLowerCase() === "n" || key.escape) {
        session.sendRequest({
          type: "permission_response",
          request_id: session.modal.request_id as string,
          allowed: false,
        });
        session.setModal(null);
        return;
      }
      return;
    }

    if (session.busy) return;

    if (showPicker) {
      if (key.upArrow) {
        setPickerIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setPickerIndex((i) => Math.min(commandHints.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const selected = commandHints[pickerIndex];
        if (selected) {
          setInput("");
          if (!handleCommand(selected)) onSubmit(selected);
        }
        return;
      }
      if (key.tab) {
        const selected = commandHints[pickerIndex];
        if (selected) setInput(selected + " ");
        return;
      }
      if (key.escape) {
        setInput("");
        return;
      }
    }

    if (!showPicker && key.upArrow) {
      const nextIndex = Math.min(history.length - 1, historyIndex + 1);
      if (nextIndex >= 0) {
        setHistoryIndex(nextIndex);
        setInput(history[history.length - 1 - nextIndex] ?? "");
      }
      return;
    }
    if (!showPicker && key.downArrow) {
      const nextIndex = Math.max(-1, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(nextIndex === -1 ? "" : (history[history.length - 1 - nextIndex] ?? ""));
      return;
    }
  });

  const onSubmit = (value: string): void => {
    if (session.modal?.kind === "question") {
      session.sendRequest({
        type: "question_response",
        request_id: session.modal.request_id as string,
        answer: value,
      });
      session.setModal(null);
      setModalInput("");
      return;
    }
    if (!value.trim() || session.busy || !session.ready) return;
    if (handleCommand(value)) {
      setHistory((items) => [...items, value]);
      setHistoryIndex(-1);
      setInput("");
      return;
    }
    session.sendRequest({ type: "submit_line", line: value });
    setHistory((items) => [...items, value]);
    setHistoryIndex(-1);
    setInput("");
    session.setBusy(true);
  };

  return (
    <Box flexDirection="column" paddingX={1} height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <ConversationView
          items={session.transcript}
          assistantBuffer={session.assistantBuffer}
          showWelcome={session.ready}
        />
      </Box>

      {session.modal ? (
        <ModalHost
          modal={session.modal}
          modalInput={modalInput}
          setModalInput={setModalInput}
          onSubmit={onSubmit}
        />
      ) : null}

      {selectModal ? (
        <SelectModal
          title={selectModal.title}
          options={selectModal.options}
          selectedIndex={selectIndex}
        />
      ) : null}

      {showPicker ? (
        <CommandPicker hints={commandHints} selectedIndex={pickerIndex} />
      ) : null}

      {session.ready && session.todoMarkdown ? (
        <TodoPanel markdown={session.todoMarkdown} />
      ) : null}

      {session.ready && (session.swarmTeammates.length > 0 || session.swarmNotifications.length > 0) ? (
        <SwarmPanel teammates={session.swarmTeammates} notifications={session.swarmNotifications} />
      ) : null}

      {session.ready ? (
        <StatusBar status={session.status} tasks={session.tasks} activeToolName={session.busy ? currentToolName : undefined} />
      ) : null}

      {!session.ready ? (
        <Box>
          <Text color={theme.colors.warning}>Connecting to backend...</Text>
        </Box>
      ) : session.modal || selectModal ? null : (
        <PromptInput
          busy={session.busy}
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          toolName={session.busy ? currentToolName : undefined}
          suppressSubmit={showPicker}
        />
      )}

      {session.ready && !session.modal && !session.busy && !selectModal ? (
        <Box>
          <Text dimColor>
            <Text color={theme.colors.primary}>enter</Text> send{"  "}
            <Text color={theme.colors.primary}>/</Text> commands{"  "}
            <Text color={theme.colors.primary}>{"\u2191\u2193"}</Text> history{"  "}
            <Text color={theme.colors.primary}>ctrl+c</Text> exit
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
