# Desktop Layered Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Desktop cross-process types single-source, remove protected unused code, and extract only the proven renderer duplication.

**Architecture:** Shared contains IPC names and type-only contracts, preload contains the runtime bridge, and renderer consumes the shared contract through its global Window declaration. Window chrome behavior becomes one renderer hook; business layouts remain separate.

**Tech Stack:** TypeScript, Electron, React 19, Vitest, ESLint

**Spec:** `docs/superpowers/specs/2026-08-19-layered-cleanup-design.md`

## Global Constraints

- Do not modify `main.css`, `utility-panel.tsx`, `browser-tool.tsx`, or `terminal-tool.tsx`.
- Shared modules must not import Electron runtime objects.
- Preserve every live IPC method and event name.
- Do not touch window/tray/pet endpoints in this plan.

---

### Task 1: Single Desktop API contract

**Files:**
- Create: `apps/desktop/src/shared/desktop-api-contract.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Test: `apps/desktop/src/preload/desktop-api.test.ts`

**Interfaces:**
- Export type `DesktopAPI` from shared.
- Export runtime `desktopAPI` from preload with `satisfies DesktopAPI`.
- Declare `Window.desktop: DesktopAPI` without a second handwritten interface.

- [ ] Add a failing contract test that detects a missing or extra bridge method/event.
- [ ] Move the interface to shared and type the preload object with `satisfies`.
- [ ] Replace the handwritten renderer declaration with a type import.
- [ ] Run focused test, node/web typechecks and touched-file lint.

### Task 2: IPC and window chrome type/behavior consolidation

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/main/core/ipc/types.ts`
- Modify: `apps/desktop/src/main/features/main-window/window.ts`
- Modify: `apps/desktop/src/preload/desktop-api.ts`
- Create: `apps/desktop/src/renderer/src/components/desktop/layout/use-desktop-window-chrome.ts`
- Modify: `apps/desktop/src/renderer/src/components/desktop/layout/main-layout.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/layout/settings-layout.tsx`
- Test: `apps/desktop/src/renderer/src/components/desktop/layout/use-desktop-window-chrome.test.ts`

**Interfaces:**
- `IpcHandlerRegistration.channel` is `IpcChannel`.
- `IpcEvents.windowMaximizedChanged` is the only constant used by sender and listener.
- `useDesktopWindowChrome()` owns maximize subscription and zoom callbacks.

- [ ] Add failing hook tests for initial state, event cleanup and zoom update.
- [ ] Centralize the maximized event and narrow registration types.
- [ ] Implement the hook and migrate only duplicated chrome logic.
- [ ] Run focused tests, typechecks and touched-file lint.

### Task 3: Remove unused code-block variants

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/ui/code-block.tsx`
- Test: `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/streamdown-renderers.test.tsx`

**Interfaces:**
- Preserve `CodeBlock`, `CopyBtn` and the renderer-facing code block behavior.
- Remove `MultiFileCodeBlock`, `LanguageTabsCodeBlock`, `InstallCommand` and helpers/imports used only by them.

- [ ] Add a focused rendering test for the retained message code block.
- [ ] Delete only unused variants and their exclusive support code.
- [ ] Run focused tests, Desktop tests, typechecks and touched-file lint.
