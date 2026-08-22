---
"@openharness/agent-runtime": minor
"@openharness/client": minor
"@openharness/coordinator": minor
"@openharness/protocol": minor
"@openharness/server": minor
"@openharness/services": minor
"@openharness/tools": minor
---

Store daemon Workflows with durable Session state, add single-owner fencing and exact protocol negotiation, and provide audited retention plus verified backup and restore APIs.

This is a clean cutover: daemon Workflow JSON migration, bare Workflow job IDs, implicit file storage, `WorkflowRunStore`, and `createOpenHarnessAgent` are not retained as compatibility paths.
