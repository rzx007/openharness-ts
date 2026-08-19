# 桌面端路由布局重构设计

## 目标

按照 TanStack Router 的文件路由和嵌套布局方式，把页面归属交给路由树，而不是让 `DesktopShell` 根据当前页面类型决定侧边栏和右侧内容。

桌面端只使用两个嵌套路由布局：

1. 主界面布局：对话、新对话和已安排。
2. 设置布局：设置导航和具体设置栏目。

`/pet` 是独立页面路由，不属于任何布局。

## 路由结构

```text
__root.tsx                         只渲染 Outlet
├─ _main.tsx                      主界面布局：Sidebar + Outlet
│  ├─ _main.index.tsx             /
│  ├─ _main.conversation.$sessionId.tsx
│  │                               /conversation/$sessionId
│  └─ _main.scheduled.tsx         /scheduled
├─ settings.tsx                   设置布局：SettingsSidebar + Outlet
│  ├─ settings.index.tsx          /settings，重定向到默认栏目
│  └─ settings.$section.tsx       /settings/$section
└─ pet.tsx                        独立页面：/pet
```

下划线开头的 `_main` 是 TanStack Router 的无路径布局：它参与组件嵌套，但不会出现在 URL 中。

## 布局职责

### 主界面布局

主界面布局固定渲染窗口标题栏、普通 `Sidebar` 和右侧 `Outlet`。它管理主界面共享的面板尺寸、工具面板、窗口操作与快捷键。

它不判断右侧应该显示对话还是已安排：

- `/` 和 `/conversation/$sessionId` 的子路由渲染对话工作区。
- `/scheduled` 的子路由渲染 `ScheduledPage`。

### 设置布局

设置布局固定渲染窗口标题栏、`SettingsSidebar` 和右侧 `Outlet`。设置侧边栏点击栏目时导航到 `/settings/$section`。

具体设置路由读取 `$section`，校验栏目并渲染 `SettingsContent`。无效栏目重定向到 `/settings/general`。

### Pet 页面

`/pet` 是独立页面，只渲染 `PetWindow`，不继承主界面或设置布局，也不新增 `PetLayout`。

## DesktopShell 的处理

删除当前 `DesktopShell`，不再通过 `view` 选择侧边栏和页面内容。

可复用的窗口外壳、标题栏和面板逻辑按实际共享范围拆到两个布局组件或小型公共组件中。不会保留一个接收 `view` 后继续决定整个页面结构的总控组件。

后续增加页面时，只需要在对应布局下增加子路由文件。布局组件不增加页面匹配用的 `if`、三元表达式或 `switch`。

## 导航与数据加载

- 会话参数校验和 `openSession` 放在 `/conversation/$sessionId` 路由的 `beforeLoad`。
- 首页初始化会话后，如果已有活动会话，重定向到对应会话地址。
- 创建新对话后导航到 `/`，由首页路由继续处理活动会话地址。
- 已安排与设置导航只发起路由导航，不直接切换布局内部状态。
- 前进和后退继续使用 TanStack Router history。

## 验证

- 路由测试验证两个布局及独立 Pet 页面的 URL 和动态参数。
- 测试无效会话、无效设置栏目及默认设置重定向。
- 检查 `DesktopShell` 被删除，并且两个布局都通过 `Outlet` 渲染右侧子页面。
- 运行桌面端完整测试、相关 ESLint 和 renderer 生产构建。
