import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { useBackendSession } from "./hooks/useBackendSession";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import { DialogProvider, useDialog } from "./ui/DialogContext";
import { ToastProvider } from "./ui/Toast";
import { DialogSelect } from "./ui/DialogSelect";
import { buildRegistry } from "./keymap/commands";
import { BUILTIN_THEMES } from "./theme/builtinThemes";
import { Home } from "./routes/Home";
import { Session } from "./routes/session/Session";
import { Footer } from "./routes/session/Footer";
import { Prompt } from "./components/prompt/Prompt";
import { TodoPanel } from "./components/TodoPanel";
import { SwarmPanel } from "./components/SwarmPanel";
import type { FrontendConfig, McpServerSnapshot, SwarmNotificationSnapshot, SwarmTeammateSnapshot, TranscriptItem } from "./types";
import type { Command } from "./keymap/commands";

// ─── AppViewProps ────────────────────────────────────────────────────────────

export type AppViewProps = {
  transcript: TranscriptItem[];
  assistantBuffer: string;
  ready: boolean;
  busy: boolean;
  status: Record<string, unknown>;
  mcpServers: McpServerSnapshot[];
  todoMarkdown: string;
  swarmTeammates: SwarmTeammateSnapshot[];
  swarmNotifications: SwarmNotificationSnapshot[];
  version?: string | null;
  history: string[];
  slashCommands: Command[];
  onSubmit: (line: string) => void;
  onCycleMode: () => void;
  dialogOpen: boolean;
};

// ─── AppView — pure rendering layer (testable) ───────────────────────────────

export function AppView({
  transcript,
  assistantBuffer,
  ready,
  busy,
  status,
  mcpServers,
  todoMarkdown,
  swarmTeammates,
  swarmNotifications,
  version,
  history,
  slashCommands,
  onSubmit,
  onCycleMode,
  dialogOpen,
}: AppViewProps): React.ReactNode {
  const { theme } = useTheme();

  if (!ready) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        <text fg={theme.colors.warning}>Connecting to backend...</text>
      </box>
    );
  }

  // Route: Home if no user/assistant items yet and not busy and no streaming
  const hasConversation = transcript.some(
    (item) => item.role === "user" || item.role === "assistant",
  );
  const isHome = !hasConversation && !busy && !assistantBuffer;

  const mode = String(status.permission_mode ?? "default");
  const model = String(status.model ?? "");
  const effortRaw = status.effort;
  const effort = typeof effortRaw === "string" && effortRaw !== "" ? effortRaw : undefined;

  const prompt = dialogOpen ? null : (
    <Prompt
      busy={busy}
      mode={mode}
      model={model}
      effort={effort}
      history={history}
      slashCommands={slashCommands}
      onSubmit={onSubmit}
      onCycleMode={onCycleMode}
    />
  );

  if (isHome) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        <Home>{prompt}</Home>
        <Footer status={status} mcpServers={mcpServers} version={version} />
      </box>
    );
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <Session items={transcript} assistantBuffer={assistantBuffer} />
      {todoMarkdown ? <TodoPanel markdown={todoMarkdown} /> : null}
      {(swarmTeammates.length > 0 || swarmNotifications.length > 0) ? (
        <SwarmPanel teammates={swarmTeammates} notifications={swarmNotifications} />
      ) : null}
      {prompt}
      <Footer status={status} mcpServers={mcpServers} version={version} />
    </box>
  );
}

// ─── Permission dialog component ─────────────────────────────────────────────

const MAX_DIFF_LINES = 40;

function DiffView({ diff }: { diff: string }): React.ReactNode {
  const allLines = diff
    .replace(/\n$/, "")
    .split("\n")
    .filter((l) => !l.startsWith("\\ No newline"));
  const lines = allLines.slice(0, MAX_DIFF_LINES);
  const truncated = allLines.length - lines.length;

  return (
    <box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return <text key={i} fg="#5c6370">{line}</text>;
        }
        if (line.startsWith("@@")) return <text key={i} fg="#56b6c2">{line}</text>;
        if (line.startsWith("+")) return <text key={i} fg="#98c379">{line}</text>;
        if (line.startsWith("-")) return <text key={i} fg="#e06c75">{line}</text>;
        return <text key={i} fg="#5c6370">{line}</text>;
      })}
      {truncated > 0 && (
        <text fg="#5c6370">{`  … ${truncated} more line(s)`}</text>
      )}
    </box>
  );
}

function PermissionDialog({
  modal,
  onRespond,
}: {
  modal: Record<string, unknown>;
  onRespond: (allowed: boolean, scope: "once" | "session") => void;
}): React.ReactNode {
  const { theme } = useTheme();
  const respondedRef = useRef(false);

  const respond = useCallback(
    (allowed: boolean, scope: "once" | "session") => {
      if (respondedRef.current) return;
      respondedRef.current = true;
      onRespond(allowed, scope);
    },
    [onRespond],
  );

  useKeyboard((key) => {
    if (key.name === "y") {
      respond(true, "once");
    } else if (key.name === "a") {
      respond(true, "session");
    } else if (key.name === "n") {
      respond(false, "once");
    }
  });

  const toolName = modal.tool_name ? String(modal.tool_name) : "tool";
  const reason = modal.reason ? String(modal.reason) : null;
  const diff = modal.diff ? String(modal.diff) : null;
  const diffPath = modal.diff_path ? String(modal.diff_path) : null;

  return (
    <box flexDirection="column">
      <text>
        <span fg={theme.colors.warning} attributes={TextAttributes.BOLD}>{"┌ "}</span>
        <span attributes={TextAttributes.BOLD}>{"Allow "}</span>
        <span fg={theme.colors.info} attributes={TextAttributes.BOLD}>{toolName}</span>
        <span attributes={TextAttributes.BOLD}>{"?"}</span>
      </text>
      {reason ? (
        <text>
          <span fg={theme.colors.warning}>{"│ "}</span>
          <span fg={theme.colors.muted}>{reason}</span>
        </text>
      ) : null}
      {diff ? (
        <box flexDirection="column">
          {diffPath ? <text fg={theme.colors.muted}>{`  ${diffPath}`}</text> : null}
          <DiffView diff={diff} />
        </box>
      ) : null}
      <text>
        <span fg={theme.colors.warning}>{"└ "}</span>
        <span fg={theme.colors.success}>{"[y] Allow"}</span>
        <span>{"  "}</span>
        <span fg={theme.colors.success}>{"[a] Allow for session"}</span>
        <span>{"  "}</span>
        <span fg={theme.colors.error}>{"[n] Deny"}</span>
      </text>
    </box>
  );
}

function QuestionDialog({
  modal,
  onSubmit,
}: {
  modal: Record<string, unknown>;
  onSubmit: (answer: string) => void;
}): React.ReactNode {
  const { theme } = useTheme();
  const [inputValue, setInputValue] = useState("");
  const question = String(modal.question ?? "Question");
  const toolName = modal.tool_name ? String(modal.tool_name) : null;
  const reason = modal.reason ? String(modal.reason) : null;

  useKeyboard((key) => {
    if (key.name === "return") {
      const trimmed = inputValue.trim();
      if (trimmed) onSubmit(trimmed);
    }
  });

  return (
    <box flexDirection="column">
      <text fg={theme.colors.accent} attributes={TextAttributes.BOLD}>
        {"? " + question}
      </text>
      {toolName ? (
        <text fg={theme.colors.muted}>{`  Tool: ${toolName}`}</text>
      ) : null}
      {reason ? (
        <text fg={theme.colors.muted}>{`  Reason: ${reason}`}</text>
      ) : null}
      <input
        focused
        placeholder="Answer..."
        onInput={(value: string) => setInputValue(value)}
      />
      <text fg={theme.colors.muted}>{"  enter: submit"}</text>
    </box>
  );
}

// ─── PERMISSION_MODES (for /permissions dialog) ───────────────────────────────

const PERMISSION_MODES = [
  {
    value: "default",
    label: "default",
    description: "Ask for approval on sensitive operations",
  },
  {
    value: "full_auto",
    label: "full_auto",
    description: "Allow all operations without asking",
  },
  {
    value: "plan",
    label: "plan",
    description: "Plan mode — propose changes before executing",
  },
];

// ─── AppInner — session + dialog wiring ──────────────────────────────────────

function AppInner({ config }: { config: FrontendConfig }): React.ReactNode {
  const renderer = useRenderer();
  const dialog = useDialog();
  const { setThemeName, theme } = useTheme();

  const session = useBackendSession(config, (code) => {
    process.exit(code ?? 0);
  });

  // Local input history (up to 100 entries)
  const [history, setHistory] = useState<string[]>([]);

  const appendHistory = useCallback((line: string) => {
    setHistory((prev) => {
      const next = [...prev, line];
      return next.length > 100 ? next.slice(next.length - 100) : next;
    });
  }, []);

  // ── handleCommand: intercept special slash commands ─────────────────────────
  const handleCommand = useCallback(
    (line: string): boolean => {
      // /theme set X
      const themeSetMatch = line.match(/^\/theme\s+set\s+(\S+)$/);
      if (themeSetMatch?.[1]) {
        setThemeName(themeSetMatch[1]);
        return true;
      }

      // /theme (no args) — open theme picker
      if (line.trim() === "/theme") {
        const themeKeys = Object.keys(BUILTIN_THEMES);
        const currentTheme = theme.name;
        dialog.replace(
          <DialogSelect
            title="Select Theme"
            items={themeKeys.map((k) => ({
              value: k,
              label: k,
              active: k === currentTheme,
            }))}
            onSelect={(value) => {
              setThemeName(value);
              dialog.close();
            }}
          />,
        );
        return true;
      }

      // /permissions or /permissions show — open permissions picker
      if (line.trim() === "/permissions" || line.trim() === "/permissions show") {
        const currentMode = String(session.status.permission_mode ?? "default");
        const currentIndex = PERMISSION_MODES.findIndex((m) => m.value === currentMode);
        dialog.replace(
          <DialogSelect
            title="Permission Mode"
            items={PERMISSION_MODES.map((m) => ({
              value: m.value,
              label: m.label,
              description: m.description,
              active: m.value === currentMode,
            }))}
            onSelect={(value) => {
              session.sendRequest({ type: "submit_line", line: `/permissions set ${value}` });
              session.setBusy(true);
              dialog.close();
            }}
            searchable={false}
            initialIndex={currentIndex >= 0 ? currentIndex : 0}
          />,
        );
        return true;
      }

      // /plan — toggle plan mode
      if (line.trim() === "/plan") {
        const currentMode = String(session.status.permission_mode ?? "default");
        const isPlan = currentMode === "plan";
        session.sendRequest({
          type: "submit_line",
          line: isPlan ? "/plan off" : "/plan on",
        });
        session.setBusy(true);
        return true;
      }

      // /resume — list sessions
      if (line.trim() === "/resume") {
        session.sendRequest({ type: "list_sessions" });
        return true;
      }

      return false;
    },
    [dialog, session, setThemeName, theme.name],
  );

  // ── openCommandPalette helper ────────────────────────────────────────────────
  const openCommandPalette = useCallback(() => {
    const registry = buildRegistry({
      backendCommands: session.commands,
      local: [
        {
          id: "app.palette",
          title: "Open Command Palette",
          keybinding: "ctrl+p",
          run: () => {
            // re-opens itself — handled externally
          },
        },
        {
          id: "app.theme",
          title: "Change Theme",
          run: () => handleCommand("/theme"),
        },
        {
          id: "app.permissions",
          title: "Change Permission Mode",
          run: () => handleCommand("/permissions"),
        },
        {
          id: "app.exit",
          title: "Exit",
          keybinding: "ctrl+c",
          run: () => {
            session.sendRequest({ type: "shutdown" });
            renderer.destroy();
            process.exit(0);
          },
        },
      ],
      submitLine: (line: string) => {
        session.sendRequest({ type: "submit_line", line });
        session.setBusy(true);
      },
    });

    const allCmds = registry.all();
    dialog.replace(
      <DialogSelect
        title="Commands"
        items={allCmds.map((cmd) => ({
          value: cmd.id,
          label: cmd.title !== cmd.id ? cmd.title : cmd.id,
          description: cmd.title !== cmd.id ? cmd.title : undefined,
          hint: cmd.keybinding,
        }))}
        onSelect={(id) => {
          dialog.close();
          const cmd = registry.get(id);
          cmd?.run();
        }}
      />,
    );
  }, [dialog, handleCommand, renderer, session]);

  // ── onSubmit ─────────────────────────────────────────────────────────────────
  const onSubmit = useCallback(
    (line: string) => {
      if (handleCommand(line)) {
        appendHistory(line);
        return;
      }
      session.sendRequest({ type: "submit_line", line });
      session.setBusy(true);
      appendHistory(line);
    },
    [appendHistory, handleCommand, session],
  );

  // ── onCycleMode ──────────────────────────────────────────────────────────────
  const onCycleMode = useCallback(() => {
    const currentMode = String(session.status.permission_mode ?? "default");
    const modeOrder = ["default", "full_auto", "plan"];
    const idx = modeOrder.indexOf(currentMode);
    const nextMode = modeOrder[(idx + 1) % modeOrder.length] ?? "default";
    session.sendRequest({ type: "submit_line", line: `/permissions set ${nextMode}` });
    session.setBusy(true);
  }, [session]);

  // ── Command registry for slashCommands prop ──────────────────────────────────
  const registry = useMemo(
    () =>
      buildRegistry({
        backendCommands: session.commands,
        local: [
          {
            id: "app.palette",
            title: "Open Command Palette",
            keybinding: "ctrl+p",
            run: openCommandPalette,
          },
          {
            id: "app.theme",
            title: "Change Theme",
            run: () => handleCommand("/theme"),
          },
          {
            id: "app.permissions",
            title: "Change Permission Mode",
            run: () => handleCommand("/permissions"),
          },
          {
            id: "app.exit",
            title: "Exit",
            keybinding: "ctrl+c",
            run: () => {
              session.sendRequest({ type: "shutdown" });
              renderer.destroy();
              process.exit(0);
            },
          },
        ],
        submitLine: (line: string) => {
          session.sendRequest({ type: "submit_line", line });
          session.setBusy(true);
        },
      }),
    [handleCommand, openCommandPalette, renderer, session],
  );

  // ── Dialog wiring for modal/selectRequest ────────────────────────────────────
  useEffect(() => {
    const modal = session.modal;
    if (!modal) return;

    if (modal.kind === "permission") {
      const requestId = modal.request_id;
      const respondedRef = { current: false };

      const sendResponse = (allowed: boolean, scope: "once" | "session"): void => {
        if (respondedRef.current) return;
        respondedRef.current = true;
        session.sendRequest({
          type: "permission_response",
          request_id: requestId,
          allowed,
          scope,
        });
        session.setModal(null);
        dialog.close();
      };

      const onClose = (): void => {
        // ESC fallback: deny if not already responded
        if (!respondedRef.current) {
          respondedRef.current = true;
          session.sendRequest({
            type: "permission_response",
            request_id: requestId,
            allowed: false,
            scope: "once",
          });
          session.setModal(null);
        }
      };

      dialog.replace(
        <PermissionDialog
          modal={modal}
          onRespond={sendResponse}
        />,
        onClose,
      );
      return;
    }

    if (modal.kind === "question") {
      const requestId = modal.request_id;

      const onClose = (): void => {
        session.setModal(null);
      };

      dialog.replace(
        <QuestionDialog
          modal={modal}
          onSubmit={(answer) => {
            session.sendRequest({
              type: "question_response",
              request_id: requestId,
              answer,
            });
            session.setModal(null);
            dialog.close();
          }}
        />,
        onClose,
      );
    }
  }, [session.modal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const req = session.selectRequest;
    if (!req) return;

    // Discard empty options
    if (req.options.length === 0) {
      session.setSelectRequest(null);
      return;
    }

    dialog.replace(
      <DialogSelect
        title={req.title}
        items={req.options.map((opt) => ({
          value: opt.value,
          label: opt.label ?? opt.value,
          description: opt.description,
        }))}
        onSelect={(value) => {
          session.sendRequest({
            type: "submit_line",
            line: `${req.submitPrefix}${value}`,
          });
          session.setBusy(true);
          dialog.close();
          session.setSelectRequest(null);
        }}
      />,
      () => {
        session.setSelectRequest(null);
      },
    );
  }, [session.selectRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Global keyboard handler ──────────────────────────────────────────────────
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      session.sendRequest({ type: "shutdown" });
      renderer.destroy();
      process.exit(0);
    }
    if (key.ctrl && key.name === "p") {
      openCommandPalette();
    }
  });

  return (
    <AppView
      transcript={session.transcript}
      assistantBuffer={session.assistantBuffer}
      ready={session.ready}
      busy={session.busy}
      status={session.status}
      mcpServers={session.mcpServers}
      todoMarkdown={session.todoMarkdown}
      swarmTeammates={session.swarmTeammates}
      swarmNotifications={session.swarmNotifications}
      version={null}
      history={history}
      slashCommands={registry.slashCommands()}
      onSubmit={onSubmit}
      onCycleMode={onCycleMode}
      dialogOpen={dialog.isOpen}
    />
  );
}

// ─── App — root with providers ───────────────────────────────────────────────

export function App({ config }: { config: FrontendConfig }): React.ReactNode {
  const initialTheme = String(config.theme ?? "default");
  return (
    <ThemeProvider initialTheme={initialTheme}>
      <DialogProvider>
        <ToastProvider>
          <AppInner config={config} />
        </ToastProvider>
      </DialogProvider>
    </ThemeProvider>
  );
}
