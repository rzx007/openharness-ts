# Agent Runtime 环境与终端设计（已取代）

> 状态：历史设计，已被 Native / WSL 方案取代。

这份 Docker 运行环境设计已经停止采用。当前权威方案是 [Native / WSL 智能体运行环境设计](./2026-09-07-native-wsl-execution-environment-design.md)。

最终实现不再包含 Docker Agent Runtime、容器挂载、共享 lease、容器 PTY 或孤儿容器回收。SRT 作为独立的本机权限能力保留。
