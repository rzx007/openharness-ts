import React, { useCallback, useMemo, useRef, useState } from "react";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useBackendSession } from "./hooks/useBackendSession";
import { useEscToCancel } from "./hooks/useEscToCancel";
import { useModalWiring } from "./hooks/useModalWiring";
import { ThemeProvider, useTheme } from "./theme/ThemeContext";
import { DialogProvider, useDialog } from "./ui/DialogContext";
import { ToastProvider, useToast } from "./ui/Toast";
import { DialogSelect } from "./ui/DialogSelect";
import { buildRegistry, type CommandRegistry } from "./keymap/commands";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from "./keymap/permissionModes";
import { BUILTIN_THEMES } from "./theme/builtinThemes";
import { AppView } from "./routes/session/AppView";
import type { FrontendConfig } from "./types";

// ─── AppInner — session + dialog wiring ──────────────────────────────────────

function AppInner({ config }: { config: FrontendConfig }) {
  const renderer = useRenderer();
  const { width: terminalWidth } = useTerminalDimensions();
  const [sidebarOpen, setSidebarOpen] = useState(() => terminalWidth >= 110);
  const dialog = useDialog();
  const { setThemeName, theme } = useTheme();
  const { toast } = useToast();

  const session = useBackendSession(
    config,
    (code) => {
      process.exit(code ?? 0);
    },
    (message) => toast(message, "error"),
  );

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
              session.sendRequest({ type: "submit_line", line: `/permissions ${value}` });
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
    [dialog, session, setThemeName, theme.name, toast],
  );

  // ── openCommandPalette helper ────────────────────────────────────────────────
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
    const idx = PERMISSION_MODE_ORDER.indexOf(currentMode);
    const nextMode = PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length] ?? "default";
    session.sendRequest({ type: "submit_line", line: `/permissions ${nextMode}` });
    session.setBusy(true);
  }, [session]);

  // ── Command registry for slashCommands prop ──────────────────────────────────
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
            id: "app.sidebar",
            title: "Toggle Sidebar",
            run: () => setSidebarOpen((v) => !v),
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
  registryRef.current = registry;

  // ── Dialog wiring for backend modal/select requests ──────────────────────────
  useModalWiring(session, dialog);

  // ── Global keyboard handler ──────────────────────────────────────────────────
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      session.sendRequest({ type: "shutdown" });
      renderer.destroy();
      process.exit(0);
    }
    if (key.ctrl && key.name === "p") {
      // 已有弹层（含后端 permission/question/select）时不顶掉：
      // dialog.replace 会触发被顶层的 onClose（permission 会被当作拒绝）。
      if (dialog.isOpen) return;
      openCommandPalette();
    }
    if (key.ctrl && key.name === "b") {
      setSidebarOpen((v) => !v);
    }
    if (key.name === "escape" && session.busy && !dialog.isOpen) {
      handleEscape();
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
      version={config.version ?? null}
      history={history}
      slashCommands={registry.slashCommands()}
      onSubmit={onSubmit}
      onCycleMode={onCycleMode}
      dialogOpen={dialog.isOpen}
      draft={draft}
      onDraftChange={setDraft}
      sidebarOpen={sidebarOpen}
      onToggleSidebar={() => setSidebarOpen((v) => !v)}
      escHint={escHint}
    />
  );
}

// ─── App — root with providers ───────────────────────────────────────────────

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
