# 默认文件打开目标设计

## 背景

设置页「常规 → 默认文件打开目标」现在是写死的「VS Code」按钮，点了不会保存，也不会改对话右上角的打开方式。

右上角打开按钮和文件树里的「打开方式」已经能扫描本机应用并打开项目或文件。右上角选过一次后，会把 id 写进 `localStorage`（`openharness.desktop.open-with.v1`）。设置页和右上角没有共用默认值。

## 目标

- 只在设置页改默认打开方式。改完后，对话右上角默认显示并使用这个应用。
- 右上角和文件树点某个应用只负责打开，不再记住、也不回写默认值。
- 设置页下拉和右上角用同一份本机应用列表、同一套图标（`OpenerIcon`，优先系统读到的应用图标）。
- Windows / macOS / Linux 都走现有 `listOpeners()` 检测，不按系统写死候选项或图标。

## 非目标

- 不改「运行环境」。
- 不改「集成终端 Shell」；侧边栏里按项目手填默认 Shell 保持原样。
- 不把打开方式同步到对话服务或其它设备。
- 不新增打开应用检测，不改各端启动参数。
- 不把以前 `localStorage` 里「上次选过谁」迁到新默认值。

## 数据存哪

默认值是本机桌面偏好，和「通知」同一份文件：

- 文件：`userData/desktop-preferences.json`
- 字段：`defaultOpenerId`，字符串或省略
- 合法值：非空字符串。非法值、缺字段、文件损坏都当成「没有默认」

`DesktopSettingsSnapshot` 增加 `defaultOpenerId: string | null`。  
`buildDesktopSettingsSnapshot` 从桌面偏好读这个字段；工作风格仍来自 daemon。

新增 IPC：`settings:update-default-opener`，入参 `{ defaultOpenerId: string }`。  
主进程校验为非空字符串后写入偏好，再返回完整 snapshot。不接受空字符串（清空不是这次的需求）。

渲染进程通过 `window.desktop.settings.updateDefaultOpener` 保存。设置页保存成功后发窗口内事件 `openharness:default-opener-changed`（detail 为新的 opener id），右上角立刻换成新默认，不必刷新页面。不再使用旧事件名 `openharness:open-with-changed`。

## 谁读、谁写

| 入口 | 读默认 | 写默认 |
|---|---|---|
| 设置页「默认文件打开目标」 | 是 | 是 |
| 对话右上角 `OpenWithSplitButton` | 是 | 否 |
| 文件树 `OpenWithSubmenu` | 是，当前默认项高亮 | 否 |

`launchWorkspaceOpener` 去掉 `persist`。右上角调用时只打开。

不再读、不再写 `localStorage` 键 `openharness.desktop.open-with.v1`。已经存在的旧值忽略。用户需要在设置页重新选一次默认应用。

## 列表从哪来

设置页候选项 = `workspace.listOpeners()`，和右上角同一份结果。当前机器没检测到的应用不出现。

三端检测保持 `opener-service.ts` 现有逻辑：

- Windows：VS Code、Visual Studio、Cursor、Antigravity、GitHub Desktop、文件资源管理器；有 Windows Terminal 显示「终端」，否则 PowerShell；装了 Git 才有 Git Bash；有 `wsl.exe` 才有 WSL。
- macOS：VS Code、Cursor、Xcode、Antigravity、GitHub Desktop、Finder；终端优先 iTerm，否则系统终端。
- Linux：VS Code / code-oss、Cursor、Antigravity、GitHub Desktop、文件管理器；终端按已装的 gnome-terminal / Konsole / xfce4-terminal / kitty 等选一个。

同一类应用三端共用 id（`vscode`、`cursor`、`terminal`）。文件夹入口 id 本来就不同（`explorer` / `finder` / `files`）。保存的是当前系统那个 id；换系统后对不上就走回退，不会误开别的程序。

## 默认怎么解析

设置页和右上角共用同一条解析，输入是「当前列表 + snapshot 里的 `defaultOpenerId`」：

1. 列表为空 → `null`（没有可用打开方式）
2. `defaultOpenerId` 能在列表里找到 → 用这一项
3. 否则按顺序找：`cursor` → `vscode` → 列表第一项

解析结果同时用于：设置页触发按钮上的图标和名称、右上角按钮当前应用、右上角菜单高亮。

## 设置页 UI

把写死的 `SettingSelect`（通用 `Code2` 图标 + 「VS Code」）换成真正的下拉，交互对齐「工作风格 / 通知」：

- 打开页时读 snapshot + `listOpeners()`
- 选一项就保存
- 加载中或保存中禁用
- 失败则回到改之前的选项，控件右侧用同一套红色说明

每一项和触发按钮都复用 `OpenerIcon`：有 `iconDataUrl` 用系统图标，没有则按 `kind` 用现有兜底（编辑器 / 文件夹 / 终端）。不要再用设置页那枚通用代码括号图标。

当前默认项在下拉里高亮。列表为空时下拉禁用，文案「未找到可用的打开方式」，不假装还能选 VS Code。

## 失败和空状态

- 保存偏好失败：设置页回滚并提示；右上角保持旧默认。
- 读偏好失败或值非法：当成没有默认，走回退，设置页不因此空白或报错。
- 打开应用失败：仍由系统处理，不改默认值。
- `listOpeners()` 失败或为空：设置页禁用下拉；右上角保持现有不可用状态，不额外弹错。

## 测试

先写测试再改实现。

1. **本机偏好：** 能读写合法 `defaultOpenerId`；非法值、坏文件都回落到「没有默认」，且不影响已有的 `notificationMode`。
2. **默认解析：** 保存的 id 在列表里就用它；不在列表或为空时按 Cursor → VS Code → 第一项；设置页和右上角共用同一条函数。
3. **写入方向：** 设置页保存会更新默认；右上角 / 文件树打开不写偏好、不写 localStorage。
4. **UI：** 设置页选项来自 `listOpeners()`，触发按钮用 `OpenerIcon`，不写死 VS Code。

验证时跑桌面相关测试、改动文件的 lint 和类型检查。

## 关键改动位置

- `apps/desktop/src/shared/settings-types.ts` — snapshot 增加字段
- `apps/desktop/src/main/features/settings/desktop-preferences.ts` — 读写 `defaultOpenerId`
- `apps/desktop/src/main/features/settings/settings-service.ts` 与 IPC / preload / 合约 — 新增更新接口
- `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx` — 真实下拉
- `apps/desktop/src/renderer/src/components/desktop/open-with/use-workspace-openers.ts` — 改读 snapshot，去掉 persist / localStorage
- `apps/desktop/src/renderer/src/components/desktop/open-with/open-with-split-button.tsx` — 打开时不再 persist
