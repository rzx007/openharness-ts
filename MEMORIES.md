# 已报告问题

- 2026-08-29 — `packages/server/src/application/attachment-processing/agent-image-to-text-host.ts:46-48,87-95` / `packages/permissions/src/index.ts:108-129,199-203`：`ImageToText` 接受绝对或越界 `image_path`，而权限检查不识别该字段，导致自动批准工具时绕过路径拒绝规则并 OCR 读取工作区外图片；引入提交 `ef842b320dfcd9732a0e8cf7a3b78aa7e7b25c8c`；状态 `pending-review`。
