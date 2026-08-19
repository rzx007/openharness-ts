# Desktop Router Layouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `DesktopShell` page-mode branches with two TanStack Router layout routes whose right-hand side is an `Outlet`, while keeping `/pet` standalone.

**Architecture:** A pathless `_main` route owns the normal sidebar and renders conversation or scheduled child routes through `Outlet`. A sibling `settings` route owns the settings sidebar and renders settings children through `Outlet`; `/pet` remains a direct child of the root route.

**Tech Stack:** React 19, TanStack Router file-based routing, Vite, Vitest, TypeScript

**Spec:** `docs/superpowers/specs/2026-08-19-desktop-router-layouts-design.md`

## Global Constraints

- Use exactly two layout components: `MainLayout` and `SettingsLayout`.
- Both layouts must render an `Outlet` to their right of their own sidebar.
- `/pet` is standalone and must not introduce a third layout component.
- Do not select pages with a `view` prop, pathname parsing, `if`, ternary, or `switch` in a shared shell.
- Preserve unrelated working-tree changes.

---

### Task 1: Lock the desired route hierarchy in a failing router test

**Files:**
- Modify: `apps/desktop/src/renderer/src/router.test.ts`
- Generated later: `apps/desktop/src/renderer/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: exported `router` from `apps/desktop/src/renderer/src/router.ts`
- Produces: a test that requires `_main` and `/settings` to own their intended child routes

- [ ] Add assertions against `router.routesById` verifying that `/`, `/conversation/$sessionId`, and `/scheduled` have `/_main` as parent; `/settings/$section` has `/settings` as parent; `/pet` has `__root__` as parent.
- [ ] Run the focused test and verify the hierarchy assertions fail against the current flat route tree.

### Task 2: Create the two layout routes and move pages into child routes

**Files:**
- Create: `apps/desktop/src/renderer/src/routes/_main.tsx`
- Create: `apps/desktop/src/renderer/src/routes/_main.index.tsx`
- Create: `apps/desktop/src/renderer/src/routes/_main.conversation.$sessionId.tsx`
- Create: `apps/desktop/src/renderer/src/routes/_main.scheduled.tsx`
- Create: `apps/desktop/src/renderer/src/routes/settings.index.tsx`
- Create: `apps/desktop/src/renderer/src/routes/settings.$section.tsx`
- Modify: `apps/desktop/src/renderer/src/routes/settings.tsx`
- Delete: the replaced flat route files

**Interfaces:**
- Produces: `MainLayout` with `Sidebar + Outlet`
- Produces: `SettingsLayout` with `SettingsSidebar + Outlet`
- Produces: child components for conversation, scheduled, and settings content

- [ ] Extract shared window/title-bar behavior without introducing page-selection state.
- [ ] Implement `_main.tsx` with a fixed normal sidebar and right-side `<Outlet />`.
- [ ] Move conversation initialization and content into the two `_main` conversation child routes.
- [ ] Move `ScheduledPage` into `_main.scheduled.tsx`.
- [ ] Turn `settings.tsx` into `SettingsLayout` and move redirect/content behavior into its child files.
- [ ] Keep `pet.tsx` as a direct standalone route.
- [ ] Run the renderer Vite build so the official plugin regenerates `routeTree.gen.ts`.
- [ ] Run the focused router test and verify the hierarchy assertions pass.

### Task 3: Remove the shared page-mode shell

**Files:**
- Delete or replace: `apps/desktop/src/renderer/src/components/desktop/desktop-shell.tsx`
- Modify: `apps/desktop/src/renderer/src/components/desktop/sidebar.tsx` only where navigation callbacks move to `MainLayout`

**Interfaces:**
- Consumes: typed TanStack Router navigation callbacks
- Produces: no shared component that accepts `view` or selects the active page

- [ ] Move reusable frame and panel pieces into focused layout components or helpers.
- [ ] Remove every `DesktopShell view=...` use and remove the `view` prop.
- [ ] Verify route files directly supply the content shown in each layout `Outlet`.

### Task 4: Verify the completed refactor

**Files:**
- Test: `apps/desktop/src/renderer/src/router.test.ts`
- Test: the existing desktop test suite

**Interfaces:**
- Produces: evidence that routing, lint, and renderer production compilation work

- [ ] Run the focused router test.
- [ ] Run all desktop Vitest tests.
- [ ] Run ESLint on every changed router/layout file.
- [ ] Run the renderer-only Vite production build.
- [ ] Run web type checking and report pre-existing failures separately from routing failures.
