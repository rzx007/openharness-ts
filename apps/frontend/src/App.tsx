import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useServerSync } from "./hooks/useServerSync";
import { useEscToCancel } from "./hooks/useEscToCancel";
import { useModalWiring } from "./hooks/useModalWiring";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import { DialogProvider, useDialog } from "./ui/DialogContext";
import { ToastProvider, useToast } from "./ui/Toast";
import { DialogSelect } from "./ui/DialogSelect";
import { buildRegistry, type CommandRegistry } from "./keymap/commands";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from "./keymap/permissionModes";
import { HISTORY_LIMIT, SIDEBAR_AUTO_OPEN_WIDTH } from "./ui/constants";
import { BUILTIN_THEMES } from "./theme/builtinThemes";
import { AppView } from "./routes/session/AppView";
import { WorkflowRunsPanel } from "./components/WorkflowRunsPanel";
import type { FrontendConfig } from "./types";
import { copySelectionToClipboard } from "./utils/selection";

// ─────────── AppInner — session + dialog wiring ─────────────

function AppInner({ config }: { config: FrontendConfig }) {
  const renderer = useRenderer();
  const { width: terminalWidth } = useTerminalDimensions();
  const [sidebarOpen, setSidebarOpen] = useState(() => terminalWidth >= SIDEBAR_AUTO_OPEN_WIDTH);
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false);
  const dialog = useDialog();
  const { setThemeName, theme } = useTheme();
  const { toast } = useToast();

  // 主题切换时同步 renderer 底色（含 OSC 11，避免透出终端背景）
  useEffect(() => {
    renderer.setBackgroundColor(theme.colors.background);
  }, [renderer, theme.colors.background]);

  const onSessionExit = useCallback((code?: number | null) => {
    process.exitCode = code ?? 0;
    renderer.destroy();
  }, [renderer]);
  const onSessionError = useCallback((message: string) => toast(message, "error"), [toast]);
  const session = useServerSync(config, onSessionError);

  // Local input history (up to 100 entries)
  const [history, setHistory] = useState<string[]>([]);

  // Prompt 草稿：dialog 打开会卸载 Prompt，提升到这里保证弹层关闭后草稿不丢
  const [draft, setDraft] = useState("");

  // 双击 Esc 取消运行中的对话
  const { escHint, handleEscape } = useEscToCancel(session.busy, () => {
    session.sendRequest({ type: "interrupt" });
  });

  const appendHistory = useCallback((line: string) => {
    setHistory((prev) => {
      const next = [...prev, line];
      return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
    });
  }, []);

  const setPermissionMode = useCallback(
    (mode: "default" | "plan" | "full_auto") => {
      session.sendRequest({ type: "set_permission_mode", permission_mode: mode });
    },
    [session],
  );

  // ──────────── handleCommand: intercept special slash commands ───────────────
  const handleCommand = useCallback(
    (line: string): boolean => {
      // /theme set X
      const themeSetMatch = line.match(/^\/theme\s+set\s+(\S+)$/);
      if (themeSetMatch?.[1]) {
        setThemeName(themeSetMatch[1]);
        toast(`Theme: ${themeSetMatch[1]}`);
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
              toast(`Theme: ${value}`);
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
              setPermissionMode(value as "default" | "plan" | "full_auto");
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
        return true;
      }

      // /sessions — list and restore sessions（/resume 作为别名保留）
      if (line.trim() === "/sessions" || line.trim() === "/resume") {
        session.sendRequest({ type: "list_sessions" });
        return true;
      }

      if (line.trim() === "/workflows" || line.trim() === "/workflow") {
        setWorkflowPanelOpen(true);
        session.sendRequest({ type: "workflow_request", workflow_action: "open" });
        return true;
      }

      return false;
    },
    [dialog, session, setThemeName, theme.name, toast],
  );

  // ─────────────────────── openCommandPalette helper ───────────────────────────
  // 复用下方 useMemo 的注册表（经 ref 解循环依赖：registry.local 里的
  // app.palette.run 也要能打开面板）。
  const registryRef = useRef<CommandRegistry | null>(null);
  const openCommandPalette = useCallback(() => {
    const registry = registryRef.current;
    if (!registry) return;
    const allCmds = registry.all();
    dialog.replace(
      <DialogSelect
        title="Commands"
        items={allCmds.map((cmd) => ({
          value: cmd.id,
          label: cmd.id,
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
  }, [dialog]);

  // ─────────────────────────────── onSubmit ────────────────────────────────────
  const onSubmit = useCallback(
    (line: string) => {
      if (handleCommand(line)) {
        appendHistory(line);
        return;
      }
      session.sendRequest({ type: "submit_line", line });
      appendHistory(line);
    },
    [appendHistory, handleCommand, session],
  );

  // ────────────────────────────────── onCycleMode ──────────────────────────────
  const onCycleMode = useCallback(() => {
    const currentMode = String(session.status.permission_mode ?? "default");
    const idx = PERMISSION_MODE_ORDER.indexOf(currentMode);
    const nextMode = PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length] ?? "default";
    setPermissionMode(nextMode as "default" | "plan" | "full_auto");
  }, [session.status.permission_mode, setPermissionMode]);

  // ──────────────── Command registry for slashCommands prop ────────────────────
  const registry = useMemo(
    () =>
      buildRegistry({
        // 优先用带描述的 command_details（补全/面板展示描述），旧后端回退纯名称；按名称排序对齐 opencode
        backendCommands: (session.commandDetails.length > 0
          ? [...session.commandDetails]
          : session.commands.map((name) => ({ name }))
        ).sort((a, b) => a.name.localeCompare(b.name)),
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
            id: "/sessions",
            title: "List & restore sessions",
            run: () => handleCommand("/sessions"),
          },
          {
            id: "app.sidebar",
            title: "Toggle Sidebar",
            run: () => setSidebarOpen((v) => !v),
          },
          {
            id: "app.workflow",
            title: "Workflow Runs",
            run: () => {
              setWorkflowPanelOpen(true);
              session.sendRequest({ type: "workflow_request", workflow_action: "open" });
            },
          },
          {
            id: "/workflow",
            title: "Open workflow runs panel",
            run: () => handleCommand("/workflow"),
          },
          {
            id: "/workflows",
            title: "Open workflow runs panel",
            run: () => handleCommand("/workflows"),
          },
          {
            id: "app.exit",
            title: "Exit",
            keybinding: "ctrl+c",
            run: () => onSessionExit(0),
          },
        ],
        submitLine: (line: string) => {
          session.sendRequest({ type: "submit_line", line });
        },
      }),
    [handleCommand, onSessionExit, openCommandPalette, session],
  );
  registryRef.current = registry;

  // ──────────── Dialog wiring for backend modal/select requests ────────────────
  useModalWiring(session, dialog);

  // ──────────────────────── Global keyboard handler ────────────────────────────
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      if (copySelectionToClipboard(renderer, toast)) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      key.preventDefault();
      key.stopPropagation();
      onSessionExit(0);
    }
    if (key.ctrl && key.name === "p") {
      // 已有弹层（含后端 permission/question/select）时不顶掉：
      // dialog.replace 会触发被顶层的 onClose（permission 会被当作拒绝）。
      if (dialog.isOpen) return;
      openCommandPalette();
    }
    if (key.name === "escape" && workflowPanelOpen) {
      setWorkflowPanelOpen(false);
      return;
    }
    if (key.ctrl && key.name === "b") {
      setSidebarOpen((v) => !v);
    }
    if (key.name === "escape" && session.busy && !dialog.isOpen) {
      handleEscape();
    }
  });

  const workflowPanelWidth = Math.min(78, Math.max(54, Math.floor(terminalWidth * 0.7)));
  const workflowPanelLeft = Math.max(0, Math.floor((terminalWidth - workflowPanelWidth) / 2));

  return (
    <>
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
        version={config.version ?? null}
        history={history}
        slashCommands={registry.slashCommands()}
        onSubmit={onSubmit}
        onCycleMode={onCycleMode}
        dialogOpen={dialog.isOpen || workflowPanelOpen}
        draft={draft}
        onDraftChange={setDraft}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        escHint={escHint}
      />
      {workflowPanelOpen ? (
        <box
          position="absolute"
          top={2}
          left={workflowPanelLeft}
          width={workflowPanelWidth}
          zIndex={90}
          border={true}
          borderColor={theme.colors.accent}
          backgroundColor={theme.colors.backgroundPanel}
          padding={1}
          flexDirection="column"
        >
          <WorkflowRunsPanel
            state={session.workflowState}
            onRefresh={() => session.sendRequest({ type: "workflow_request", workflow_action: "refresh" })}
            onSelectRun={(runId) => session.sendRequest({ type: "workflow_request", workflow_action: "select_run", workflow_run_id: runId })}
            onSetFilter={(filter) => {
              const hasTaskId = Object.prototype.hasOwnProperty.call(filter, "taskId");
              const hasEventType = Object.prototype.hasOwnProperty.call(filter, "eventType");
              const hasStatus = Object.prototype.hasOwnProperty.call(filter, "status");
              session.sendRequest({
                type: "workflow_request",
                workflow_action: "set_filter",
                workflow_task_id: hasTaskId ? filter.taskId ?? "" : undefined,
                workflow_event_type: hasEventType ? filter.eventType ?? "" : undefined,
                workflow_status: hasStatus ? filter.status ?? "" : undefined,
              });
            }}
            onClearFilters={() => session.sendRequest({ type: "workflow_request", workflow_action: "clear_filters" })}
            onCancelRun={(runId) => session.sendRequest({
              type: "workflow_request",
              workflow_action: "cancel",
              workflow_run_id: runId,
              workflow_cancel_reason: "Cancelled from TUI",
            })}
            onSelectReconcileAction={(runId, actionId) => session.sendRequest({
              type: "workflow_request",
              workflow_action: "reconcile",
              workflow_run_id: runId,
              workflow_reconcile_action_id: actionId,
            })}
            onRunReconcileAction={(runId, actionId) => session.sendRequest({
              type: "workflow_request",
              workflow_action: "run_reconcile",
              workflow_run_id: runId,
              workflow_reconcile_action_id: actionId,
            })}
          />
        </box>
      ) : null}
    </>
  );
}

// ───────────────────────── App — root with providers ─────────────────────────

export function App({ config }: { config: FrontendConfig }) {
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
