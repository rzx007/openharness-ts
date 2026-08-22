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

## C++ 原生模块

桌面应用依赖两份需要编译的 C++ 插件，不是纯 JavaScript 包：

- `node-pty`：在本机开真正的终端（伪终端）。
- `better-sqlite3`：本地 SQLite 数据库。

`pnpm install` 装完 JS 依赖后，`postinstall` 会再跑 `electron-builder install-app-deps`。这一步按 **Electron 自己的 Node 版本** 重编译这些插件。给普通 Node 装好的 `.node` 文件不能直接给 Electron 用。

Windows 上如果缺 Visual Studio 的 C++ 工具链，或没装 Spectre 缓解库，`node-pty` 会编译失败，整次 `pnpm install` 跟着失败。典型报错：

```text
MSB8040: Spectre-mitigated libraries are required
node-gyp failed to rebuild ...\node-pty
```

处理办法：

1. 打开 **Visual Studio Installer**，修改 VS 2022。
2. 在 **单个组件** 里勾选 **MSVC v143 - VS 2022 C++ x64/x86 Spectre 缓解库（最新）**。
3. 同时确保已安装 **使用 C++ 的桌面开发** 工作负载（含 Windows SDK、MSVC 编译器）。
4. 装完后在仓库根目录重新执行 `pnpm install`。

`better-sqlite3` 通常能编过；卡住的几乎都是 `node-pty`。没编成功之前，桌面里的内嵌终端无法启动。

## Checks

```bash
pnpm --filter @openharness/desktop typecheck
pnpm --filter @openharness/desktop lint
```
