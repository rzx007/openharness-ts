# @openharness/jobs

Portable control protocol for long-running OpenHarness work.

The package defines owner-scoped snapshots and the common `list`, `read`, `wait`, `send`, and
`cancel` operations. Producers keep ownership of execution and storage: terminals remain in the
terminal provider, tasks remain in `TaskManager` and `SessionTaskRecord`, and workflows remain in
`WorkflowRunStore`.
