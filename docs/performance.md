# Briefing performance on large ledgers

`alethic resume` compiles a briefing from every record in `.alethic/`. This page records how compilation time and output size behave as the ledger grows, and why no cache or index was added.

## Method

A generated repository with 200 source files, one task scoped to `src/**`, and a ledger of accepted decisions (each scoped to one module, so all of them overlap the task) plus imported receipts on the current line of history. Each briefing was compiled twice at 1000 and 2500 tokens from the built CLI, and the second run was compared byte for byte with the first. The generator is the same shape as `test/e2e/resume-scale.test.ts`, which runs 300 and 1500 decisions on every test run.

Measured on 2026-09-14, Apple M4 Pro, Node v26.7.0, git 2.50.1. Times are wall-clock for one `resume` process, including Node startup.

## Results

| Ledger | Budget | Before | After | Output (approx. tokens) | Longest "N more" line | Deterministic |
|---|---|---|---|---|---|---|
| 300 decisions, 60 receipts | 1000 | 2.7 s | 0.37 s | 989 | 148 chars | yes |
| 300 decisions, 60 receipts | 2500 | 2.7 s | 0.36 s | 2494 | 110 chars | yes |
| 2000 decisions, 400 receipts | 1000 | 16.7 s | 1.05 s | 993 | 153 chars | yes |
| 2000 decisions, 400 receipts | 2500 | 17.4 s | 1.08 s | 2492 | 155 chars | yes |

"Before" is the compiler with capped pointer lines but without memoized Git lookups; "after" adds them.

## What the measurements showed

- **Output size was already bounded by the budget,** once collapsed lines were capped at five citations. Before the cap, a single "N more" line listed every hidden record and could exceed the budget on its own.
- **Time was almost all Git processes.** A CPU profile of the 2000-decision run spent 15.7 of 17.0 seconds idle, waiting for child processes: each receipt resolved its commit and checked ancestry, and each check was a separate `git` invocation, even though the receipts named the same commit.
- **Allocation and rendering were not the bottleneck** at these sizes (well under a second combined).

## Decision

Memoize commit queries for the duration of one command (`createGitLookups` in `src/git/git.ts`). This keeps the source of truth in Git and YAML, adds no state to invalidate, and brought both ledgers to about a second or less.

No persistent cache or index was added. Revisit if a real ledger shows either of these:

- many distinct commits across receipts, so memoization no longer collapses the Git queries (batching them through `git cat-file --batch-check` is the next step);
- allocation time growing with thousands of items in one section, since each upgrade re-renders the content (incremental length accounting is the next step).

## Concurrent-work notices

`resume` also reads other local branches and worktrees (spec §12.1). Each source costs a few short Git processes: a merge base, a diff of its record directories, and a diff of its code paths for a branch; for a worktree, three reads of its record directories' status plus its changed paths. The changed record files of every branch are read through one `git cat-file --batch` process, worktree record files are read from disk without hashing the rest of the ledger, and sources are read four at a time.

Measured on 2026-09-29, Apple M4 Pro, Node v26.10.0, git 2.50.1, with the ledger above plus 25 branches (each changing one file and adding two decisions in scope) and 2 worktrees (each with one uncommitted decision and an uncommitted edit):

| Ledger | `resume --no-concurrent` | `resume` | `status --all-branches` | Deterministic |
|---|---|---|---|---|
| 300 decisions, 27 sources | 0.35 s | 0.73 s | 0.64 s | yes |
| 2000 decisions, 27 sources | 1.24 s | 1.73 s | 0.92 s | yes |

The cost depends on the number of sources (at most 25 branches and worktrees are examined) and on how much each changed, not on the size of the ledger. `--no-concurrent` skips it.
