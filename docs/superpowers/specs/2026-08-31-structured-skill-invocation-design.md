# Slash Skill 原生调用设计

日期：2026-08-31

状态：待审核

## 结论

Slash Skill 不需要单独的执行接口，也不需要再实现一套 skill 加载流程。

它只是普通用户消息的另一种输入方式：客户端在提交普通消息时，附带一份 `skillInvocation` metadata。服务端根据 metadata 把本轮模型输入整理成“明确指定某个 skill”的自然语言指令，agent 随后使用现有的原生 `Skill` 工具加载该 skill。

例如用户看到的是：

```text
[Skill: archify] 画一下系统架构
```

普通消息接口收到：

```json
{
  "content": "画一下系统架构",
  "metadata": {
    "skillInvocation": {
      "name": "archify",
      "commandName": "archify",
      "source": "user",
      "invocationSource": "slash"
    }
  }
}
```

本轮实际交给 agent 的用户输入是：

```text
请先使用 Skill 工具加载 archify 技能，然后按该技能要求完成下面的任务：

画一下系统架构
```

后面的读取、资源定位和执行全部走现有原生 Skill 机制。

## 为什么这样设计

当前问题不是缺少一种新的 command 执行协议，而是 Slash Skill 仍在把整份 `SKILL.md` 展开成用户消息。

现有系统已经具备需要的基础能力：

- 普通消息通过 `POST /sessions/:sessionId/prompts` 提交，并且请求体已经支持 `metadata`。
- agent 已注册原生 `Skill` 工具。
- `Skill` 工具通过当前 session 的 cwd 和统一 skill registry 查找用户级、项目级、插件级和内置 skill。
- transcript 和 UI 可以根据消息 metadata 决定展示形式。

因此，Slash Skill 只需要负责“明确指定要调用哪个 skill”，不应该负责读取或展开 skill。

## 目标

- `/archify 画一下系统架构` 复用普通消息提交接口。
- 不再把 `SKILL.md` 正文作为用户消息发送或持久化。
- 不使用 `POST /sessions/:sessionId/commands` 执行 Slash Skill。
- agent 通过现有原生 `Skill` 工具读取实际 skill。
- 消息列表只显示 skill 胶囊和用户任务。
- 复杂 skill 能知道自己的实际目录，正确定位 `scripts/`、`references/`、`assets/` 等资源。
- Slash 菜单显示所有可由用户调用的 skill，包括项目级、用户级、插件级和内置 skill。
- 不为旧的文本展开方式保留兼容分支。

## 非目标

- 不新增第二套 skill loader。
- 不把 skill 正文拼进 system prompt。
- 不给 `QueryEngine` 新增 `perTurnSystemContext`。
- 不从客户端接收或信任任意 skill 文件路径。
- 不重设计 `SKILL.md` 格式。
- 不要求 `SKILL.md` 列出 skill 目录中的每个文件。
- 不迁移旧会话中已经展开的 skill 正文。
- 不改变模型自行发现和调用 skill 的一般行为。

## 数据结构

普通消息继续使用现有 payload，只在 metadata 中增加明确类型：

```ts
type SkillInvocationMetadata = {
  name: string;
  commandName?: string;
  displayName?: string;
  source?: "bundled" | "plugin" | "user" | "project" | string;
  invocationSource: "slash";
};

type AdmitPromptInput = {
  content: string;
  metadata?: {
    skillInvocation?: SkillInvocationMetadata;
    [key: string]: unknown;
  };
};
```

这里故意不放这些字段：

- 不放 `skill.content`，避免正文进入消息存储。
- 不放 `path` 和 `root`，避免客户端 metadata 变成文件读取依据。
- 不重复保存 `args`；`content` 就是用户在 Slash Skill 后输入的任务。

`displayName` 和 `source` 只是 UI 快照。即使以后 skill 被改名或删除，旧消息仍能按提交时的信息显示。它们不参与文件读取。

## 完整运行流程

### 1. Slash 菜单选择 skill

客户端通过现有 `GET /commands?cwd=...` 获取当前目录可用的 Slash Skill。

菜单展示 skill 名称、简介、command（例如 `/archify`）和来源。这里的命令目录只负责发现和选择，不负责展开 `SKILL.md`。

### 2. 通过普通消息接口提交

用户提交 `/archify 画一下系统架构` 时，客户端调用现有接口：

```text
POST /sessions/:sessionId/prompts
```

请求中的 `content` 是用户任务，`metadata.skillInvocation` 表示用户显式指定了 `archify`。

不再调用：

```text
POST /sessions/:sessionId/commands
```

当前这条 POST 链路只用于把 Skill 模板展开成 prompt，没有承载其他独立命令。因此实施时直接删除对应的 `expand()` 能力、客户端方法、服务端路由和测试。`GET /commands` 仍保留，用于 Slash 菜单发现；内置 Slash 命令继续走各自已有的资源 API。

### 3. 服务端生成本轮 agent 输入

消息入库时保持原始内容：

```text
画一下系统架构
```

运行到 `session-run-executor` 时，根据 metadata 生成本轮提交给 agent 的文本：

```text
请先使用 Skill 工具加载 archify 技能，然后按该技能要求完成下面的任务：

画一下系统架构
```

如果没有 `metadata.skillInvocation`，内容完全不变。

这一步只做轻量文本整理：不读取 skill registry，不读取 `SKILL.md`，不注入 skill 正文，也不新增特殊的 agent 调用类型。

`metadata` 仍随 `input.accepted` 事件投影，供 transcript 和 UI 使用。

### 4. agent 使用原生 Skill 工具

agent 收到明确指令后，调用现有工具：

```text
Skill({ name: "archify" })
```

`Skill` 工具继续负责：

1. 使用当前 session cwd 刷新 skill registry。
2. 按名称解析 skill。
3. 从 registry 中读取实际 `SKILL.md` 内容。
4. 把加载结果返回给 agent。

用户显式选择 skill 时，模型指令必须明确要求“先调用 Skill 工具再执行任务”，不能只写“参考 archify”，否则模型可能跳过加载。

### 5. 原生 Skill 工具补充位置上下文

复杂 skill 的目录可能包含 `scripts/`、`references/`、`assets/` 或其他资源，而 `SKILL.md` 不一定枚举完整目录树。

因此需要增强现有 `Skill` 工具的返回文本。除 skill 正文外，同时返回 registry 中已经可信解析出的实际位置：

```text
Skill: archify
Skill file: C:\Users\ruanz\.openharness-ts\skills\archify\SKILL.md
Skill root: C:\Users\ruanz\.openharness-ts\skills\archify

Resolve relative paths mentioned by this skill against Skill root.

<skill-content>
...SKILL.md 正文...
</skill-content>
```

路径来自服务端 registry，不来自客户端 metadata。这样 Slash Skill 和模型主动调用 Skill 都能获得相同的位置能力，不会只修好其中一种入口。

### 6. transcript 和消息 UI

transcript 投影保留用户任务和 `metadata.skillInvocation`。桌面端看到 metadata 后渲染：

```text
[Skill: archify · 个人]
画一下系统架构
```

普通消息列表不显示绝对路径，也不显示 `SKILL.md` 正文。路径只出现在 Skill 工具结果或调试信息中。

复制消息时默认复制用户任务。编辑消息时默认保留 `skillInvocation`，只编辑用户任务。

## Slash 菜单来源

Slash Skill 菜单应展示所有 `userInvocable` 的 skill，不应只接受某一个固定 source 字符串。

建议排序：项目级、用户级、插件级、内置。来源只影响展示和排序，不改变原生 Skill 工具的解析规则。

## 安全边界

- 客户端 metadata 只能表达“用户选择了哪个名字的 skill”。
- metadata 不能提供 skill 正文、可信路径或文件读取授权。
- 真正的 skill 内容和路径只能由原生 Skill 工具通过 registry 获取。
- skill 不存在时，由原生 Skill 工具返回 `Skill not found`，agent 应把错误说明给用户。
- 同名 skill 的覆盖优先级沿用现有 registry 规则，不在 Slash 入口另建一套规则。

## 与之前方案的区别

之前方案准备让 executor 读取 registry、加载 skill 正文，再通过一次性的 system context 注入 `QueryEngine`。这会让 Slash 入口形成一条与原生 `Skill` 工具并行的加载链路。

本方案删除这些设计：

- 删除结构化 command 执行结果。
- 删除 executor 中的 skill resolve 和正文读取。
- 删除 `perTurnSystemContext`。
- 删除 Slash 专用的 skill system prompt。
- 删除客户端提交的 `path`、`root` 和 `args` 副本。

最终只有一套加载机制：原生 `Skill` 工具。Slash 只是明确触发它的入口。

## 测试计划

### 普通消息提交

- 选择 Slash Skill 后调用 `POST /sessions/:sessionId/prompts`。
- `content` 只包含用户任务。
- metadata 包含 `skillInvocation.name` 和 `invocationSource: "slash"`。
- payload 不包含 skill 正文、path 或 root。
- Slash Skill 不调用 `POST /sessions/:sessionId/commands`。

### agent 输入转换

- 有 `skillInvocation` 时，本轮 agent 输入明确要求先调用指定的 `Skill` 工具。
- 转换后的文本包含原始用户任务。
- 没有 `skillInvocation` 时，agent 输入不变。
- durable input 和 transcript 仍保存原始用户任务，不保存转换文本或 skill 正文。

### 原生 Skill 工具

- 按当前 cwd 正确加载用户级、项目级、插件级和内置 skill。
- 返回内容包含 `SKILL.md` 正文、实际 skill 文件路径和根目录。
- 相对资源解析说明指向 skill root。
- 不存在的 skill 返回明确错误。

### transcript 和 UI

- Skill 消息显示胶囊、来源和用户任务。
- 不显示 `SKILL.md` 正文。
- 普通消息渲染不受影响。
- 复制和编辑操作针对用户任务。

### Slash 菜单

- 展示所有可由用户调用的项目级、用户级、插件级和内置 skill。
- 正确显示来源标签。
- 排序符合“项目 > 个人 > 插件 > 内置”。

## 实施范围

1. 给普通消息 metadata 增加 `skillInvocation` 类型。
2. 修改 Slash Skill 提交逻辑，改走普通 prompt 接口。
3. 在 run executor 提交给 agent 前，根据 metadata 生成明确的 Skill 工具调用指令。
4. 增强原生 `Skill` 工具返回值，附带可信的 skill file 和 skill root。
5. transcript 投影保留 skill invocation metadata。
6. 桌面消息组件渲染 skill 胶囊。
7. Slash 菜单展示全部可用户调用的 skill 和来源。
8. 删除 Slash Skill command POST 链路和 command catalog 的 `expand()` 能力；保留 GET command catalog。
9. 补齐测试并运行 typecheck。

## 已确认的审核结论

- Slash Skill 只负责生成“请先调用 Skill 工具”的普通用户输入。
- metadata 仅保存名称和 UI 快照，不保存 path、root、正文或 args 副本。
- 增强原生 `Skill` 工具，让所有调用入口都能获得 skill file 和 skill root。
- 直接删除 `POST /sessions/:sessionId/commands` 和 command catalog 的 `expand()` 能力，不保留兼容分支。
- 编辑 Skill 消息时保留 skill，只修改用户任务。
