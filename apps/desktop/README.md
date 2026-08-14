# OpenHarness Desktop

Electron + React desktop shell for OpenHarness.

## Structure

- `src/main/core`: app context, window manager, IPC registry, lifecycle helpers.
- `src/main/features/main-window`: primary application window behavior.
- `src/main/features/tray`: system tray menu, notification, and tray flash helpers.
- `src/main/features/pet`: transparent desktop Pet window, visibility, click-through, and position persistence.
- `src/preload`: safe renderer-facing desktop API exposed as `window.desktop`.
- `src/shared`: IPC channel names and shared request/result types.

## Development

```bash
pnpm install
pnpm --filter @openharness/desktop dev
```

## Checks

```bash
pnpm --filter @openharness/desktop typecheck
pnpm --filter @openharness/desktop lint
```
