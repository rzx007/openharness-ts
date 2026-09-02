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
Task 3: minor (deferred): compact context helper does not have an explicit null-source regression, though implementation omits null correctly.
Task 3: minor (deferred): provider failure has direct coverage, while ordinary summarizer failure retaining simpleCompact fallback is verified statically but lacks a new end-to-end regression.
Task 3: complete (commits c10c083..cf4b041, review clean)
Task 4: complete (commits cf4b041..877474d, review clean)
Task 5: fix round 1/5 (1 addressed — real attachment Host resolves only live child sessions to the root authorization session; commits 62deb86..69efde2)
Task 5: fix round 2/5 (1 addressed — real daemon/default-agent/child/Read/JobWait end-to-end authorization coverage; commit c925131)
Task 5: complete (commits 877474d..c925131, review clean)
Phase 2: complete (four workspace tests, full type-check, docs check, capability boundaries, managed Memory, compact context, and real child attachment authorization accepted)
Task 5: complete (standalone attachment states, sandbox-only resource root, and child session-tree Host borrowing verified)
Phase 2: accepted (core/tools/agent-runtime/server suites, full type checks, docs, and boundary grep checklist verified)
