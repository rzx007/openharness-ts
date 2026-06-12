import React, { useState, useEffect, useRef, useCallback } from "react";
import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import type { TextareaRenderable } from "@opentui/core";
import { useTheme } from "../../theme/ThemeContext";
import { Autocomplete, getAutocompleteSuggestions } from "./Autocomplete";
import type { Command } from "../../keymap/commands";

export type PromptProps = {
  busy: boolean;
  placeholder?: string;
  mode: string;
  model: string;
  effort?: string;
  history: string[];
  slashCommands: Command[];
  onSubmit: (line: string) => void;
  onCycleMode: () => void;
  /** 草稿提升：弹层打开会卸载 Prompt，草稿由父级持有，重挂载时恢复 */
  draft?: string;
  onDraftChange?: (text: string) => void;
};

const DEFAULT_PLACEHOLDER = 'Ask anything... "Fix broken tests"';

const MODE_LABELS: Record<string, string> = {
  default: "Default",
  full_auto: "Auto",
  plan: "Plan",
};

function getModeLabel(mode: string): string {
  return MODE_LABELS[mode] ?? mode;
}

export function Prompt({
  busy,
  placeholder = DEFAULT_PLACEHOLDER,
  mode,
  model,
  effort,
  history,
  slashCommands,
  onSubmit,
  onCycleMode,
  draft,
  onDraftChange,
}: PromptProps): React.ReactNode {
  const { theme } = useTheme();

  // Content state (synced from textarea via onContentChange)
  const [content, setContent] = useState("");

  // Autocomplete state
  const [acOpen, setAcOpen] = useState(false);
  const [acIndex, setAcIndex] = useState(0);

  // History navigation state
  const [histIdx, setHistIdx] = useState<number | null>(null);

  // Spinner state for busy
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  // Dynamic textarea height (1–6 lines)
  const [textareaHeight, setTextareaHeight] = useState(1);

  // Textarea ref for imperative operations
  const textareaRef = useRef<TextareaRenderable | null>(null);

  // Restore lifted draft once on mount (Prompt is unmounted while dialogs are open)
  useEffect(() => {
    if (draft && textareaRef.current) {
      textareaRef.current.insertText(draft);
      setContent(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive autocomplete suggestions
  const acSuggestions = acOpen
    ? getAutocompleteSuggestions(content, slashCommands)
    : [];

  // Determine if autocomplete should be open
  const shouldShowAc = !busy && content.startsWith("/") && content.length > 0;

  // Sync acOpen with shouldShowAc
  useEffect(() => {
    if (!shouldShowAc) {
      setAcOpen(false);
      setAcIndex(0);
    } else {
      setAcOpen(true);
    }
  }, [shouldShowAc]);

  // Reset acIndex when content changes (new filter)
  useEffect(() => {
    setAcIndex(0);
  }, [content]);

  // Spinner interval when busy; reset frame when no longer busy (Bug 4)
  useEffect(() => {
    if (!busy) {
      setSpinnerFrame(0);
      return;
    }
    const frames = theme.icons.spinner;
    const id = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % frames.length);
    }, 100);
    return () => clearInterval(id);
  }, [busy, theme.icons.spinner]);

  // Clear textarea imperatively
  const clearTextarea = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.clear();
    }
    setContent("");
    setHistIdx(null);
    onDraftChange?.("");
  }, [onDraftChange]);

  // Handle textarea onSubmit (triggered by Return key)
  const handleTextareaSubmit = useCallback(() => {
    if (busy) return;

    // If autocomplete is open, handle through autocomplete (don't also submit text)
    if (acOpen) {
      const suggestion = acSuggestions[acIndex];
      if (suggestion) {
        suggestion.run();
        clearTextarea();
        setAcOpen(false);
      }
      return;
    }

    const text = textareaRef.current?.plainText ?? content;
    const trimmed = text.trim();
    if (trimmed === "") return;

    onSubmit(trimmed);
    clearTextarea();
  }, [busy, acOpen, acSuggestions, acIndex, content, onSubmit, clearTextarea]);

  // Global keyboard handler
  useKeyboard((key) => {
    if (key.name === "tab") {
      if (acOpen) {
        // Complete with highlighted suggestion
        const suggestion = acSuggestions[acIndex];
        if (suggestion && textareaRef.current) {
          const completed = suggestion.id + " ";
          textareaRef.current.clear();
          textareaRef.current.insertText(completed);
          // Bug 2: sync content state immediately so derived acSuggestions/acOpen
          // use the updated value without waiting for the async onContentChange event.
          setContent(completed);
        }
      } else {
        onCycleMode();
      }
      return;
    }

    if (key.name === "up") {
      if (acOpen) {
        setAcIndex((prev) => Math.max(0, prev - 1));
      } else {
        // Bug 1: read from ref to avoid stale closure — content state may lag
        const currentText = textareaRef.current?.plainText ?? "";
        if (currentText === "") {
          // History navigation: up → older
          const newIdx =
            histIdx === null
              ? history.length - 1
              : Math.max(0, histIdx - 1);
          if (history.length > 0 && newIdx >= 0) {
            setHistIdx(newIdx);
            const entry = history[newIdx];
            if (entry !== undefined && textareaRef.current) {
              textareaRef.current.clear();
              textareaRef.current.insertText(entry);
            }
          }
        }
      }
      return;
    }

    if (key.name === "down") {
      if (acOpen) {
        setAcIndex((prev) =>
          Math.min(Math.max(0, acSuggestions.length - 1), prev + 1),
        );
      } else {
        // Bug 1: read from ref to avoid stale closure
        const currentText = textareaRef.current?.plainText ?? "";
        if (currentText === "") {
          // History navigation: down → newer
          if (histIdx !== null) {
            const newIdx = histIdx + 1;
            if (newIdx >= history.length) {
              // Past the end: clear input
              setHistIdx(null);
              clearTextarea();
            } else {
              setHistIdx(newIdx);
              const entry = history[newIdx];
              if (entry !== undefined && textareaRef.current) {
                textareaRef.current.clear();
                textareaRef.current.insertText(entry);
              }
            }
          }
        }
      }
      return;
    }

    if (key.name === "escape") {
      if (acOpen) {
        setAcOpen(false);
        setAcIndex(0);
      } else {
        clearTextarea();
      }
      return;
    }
  });

  const modeLabel = getModeLabel(mode);

  const keyBindings = [
    // shift+return → newline
    { name: "return", shift: true, action: "newline" as const },
    // return → submit
    { name: "return", action: "submit" as const },
  ];

  // flexShrink=0：防止 Session 路由下被 scrollbox 挤压裁掉 meta 行
  return (
    <box flexDirection="row" flexShrink={0}>
      {/* Left accent bar */}
      <box width={1} backgroundColor={theme.colors.accent} />

      {/* Right content column */}
      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={theme.colors.backgroundPanel}
        paddingLeft={1}
        paddingRight={1}
      >
        {/* Autocomplete floats above textarea */}
        {acOpen && acSuggestions.length > 0 && (
          <Autocomplete
            query={content}
            commands={slashCommands}
            selectedIndex={acIndex}
          />
        )}

        {/* Multiline textarea */}
        <textarea
          ref={textareaRef}
          focused={!busy}
          placeholder={placeholder}
          placeholderColor={theme.colors.muted}
          keyBindings={keyBindings}
          onSubmit={handleTextareaSubmit}
          onContentChange={() => {
            // Read plainText from ref on next tick (event has no content)
            const text = textareaRef.current?.plainText ?? "";
            setContent(text);
            onDraftChange?.(text);
            // Bug 3: update height based on line count (1–6 rows)
            const lineCount = textareaRef.current?.lineCount ?? 1;
            setTextareaHeight(Math.min(6, Math.max(1, lineCount)));
          }}
          height={textareaHeight}
          flexShrink={0}
        />

        {/* 输入区与元信息行之间留一行（对齐 opencode 观感） */}
        <text>{""}</text>

        {/* Meta info row */}
        {busy ? (
          <box flexDirection="row">
            <text fg={theme.colors.accent}>
              {theme.icons.spinner[spinnerFrame] ?? "⠋"}
            </text>
            <text fg={theme.colors.muted}>{" working..."}</text>
          </box>
        ) : (
          <box flexDirection="row">
            <text
              fg={theme.colors.accent}
              attributes={TextAttributes.BOLD}
            >
              {modeLabel}
            </text>
            <text fg={theme.colors.foreground}>{` · ${model}`}</text>
            {effort != null && effort !== "" && (
              <text fg={theme.colors.warning}>{` · ${effort}`}</text>
            )}
          </box>
        )}
      </box>
    </box>
  );
}
