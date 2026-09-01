# SDD ledger — plan: docs/superpowers/plans/2026-09-01-agent-runtime-default-capabilities-phase-2.md

Depends on completion of phase 1.
Execution branch: feat/agent-runtime-default-capabilities
Constraint: use the current checkout; do not create a worktree.
Protected user change: apps/desktop/src/main/features/session/session-service.test.ts is staged and must not enter task commits.
Task 1: minor (deferred): Workflow-disabled regression directly covers list/read but not cancel, though cancel shares the guarded resolve path; final branch review may add a direct assertion.
Task 1: minor (documentation only): report says override repository is outside agent cwd, but it is actually outside the default Workflow directory while still nested under cwd; test semantics remain valid.
Task 1: complete (commits ad4097d..444f712, review clean)
Task 2: complete (Memory remains agent-runtime-owned; default creation, equivalent disable paths, managed path safety, and same-run Remember suppression verified)
Task 2 fix round 1: complete (duplicate suppression now requires a current-run managed write with a matching successful tool result)
Task 2 fix round 2: complete (completed framework runs now provide an explicit message snapshot across steering, compaction, and history replacement)
Task 2 fix round 3: complete (framework runs now record successful tool activity independently of auto-compacted history; failed and cancelled runs leave no success fact)
Task 5: complete (standalone attachment states, sandbox-only resource root, and child session-tree Host borrowing verified)
Phase 2: accepted (core/tools/agent-runtime/server suites, full type checks, docs, and boundary grep checklist verified)
