# Roadmap

Alethic is pre-release. This page lists what exists, what is needed before a first published release, and what may come later. Items can move as real use shows what matters.

## Done (v0)

- Record format v1: tasks, decisions, knowledge, checkpoints, and receipts, with JSON Schemas and a normative [spec](docs/spec.md) whose examples are tested.
- Validator for schema, references, secrets, expiring leases, trust labels, path safety, missing commits, and append-only history. There is also a GitHub Action.
- Task, decision, knowledge, receipt, and checkpoint commands, with an end-to-end handoff test.
- `resume`: a deterministic, cited, approximately budgeted briefing, with golden outputs at 1000, 2500, and 5000 tokens.
- Instruction blocks for `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, PR summaries, and a stdio MCP server tested with the official MCP client.
- Content-based staleness that survives squash merges and shallow clones, plus `verify`, contradiction and overlapping-claim detection, and `doctor`.
- A demo that hands one task from Codex to Claude Code to Gemini, run by the test suite.

## Done (improvement plan, see [IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md))

- **Checked before compiled.** Briefings, PR summaries, record views, MCP resources, and the dashboard use the same record assessment as `validate`; invalid, forged, or secret-bearing records are withheld and reported.
- **Conservative freshness.** Any change to cited evidence needs re-verification, sized with an order-respecting diff; `scope_changed` and `uncertain` are explicit.
- **Attributed human confirmation.** `--human` is recorded as an attribution, bound to the confirmed text, and never shown as authenticated approval; the spec states the trust boundary.
- **`receipt run`.** Checks observed by Alethic, with content digests before and after, and applicability judged by content rather than commit.
- **Bounded briefings.** Capped pointer lines, `alethic show`, an inspectable JSON result, and memoized Git lookups ([measurements](docs/performance.md)).
- **Sessions and competing writes.** `ALETHIC_SESSION`, session-aware leases and overlap warnings, locked and version-checked record writes, and competing-claim detection.
- **Input from files.** `--from-file` and stdin for checkpoints, decisions, and knowledge.
- **Evaluation kit.** Reproducible handoff scenarios in three conditions and a protocol ([evaluation](docs/evaluation.md)).
- **Dashboard.** A read-only local view of sessions, records, handoffs, briefings, and health ([dashboard](docs/dashboard.md)).

## Done (after the improvement plan)

- **Concurrent-work notices.** `resume` reports other local branches and worktrees that changed files in the task's scope, or recorded tasks, decisions, and knowledge about it, since they split; uncommitted records in other worktrees count and are labeled. `status --all-branches` lists every source, and `show --ref` reads a cited record. Records from other sources pass the same checks with this checkout's privacy settings (spec §12.1).

## Before the first release

- **Publish** to npm as `alethic` (unclaimed when checked on 2026-09-29), with the `alethic` command.
- **Run the handoff evaluation in live sessions** of Codex, Claude Code, and Gemini CLI, following [docs/evaluation.md](docs/evaluation.md), and publish the results, including cases where a handoff file was enough. This also verifies the adapters, which are so far checked only against vendor documentation and the official MCP client.
- **Antigravity setup**, verified the same way.
- **Demo media**: a short video; the README has a dashboard screenshot.
- **Use Alethic in its own development** across sessions, and record the capture friction it exposes.

## Next

- **Remote branches in concurrent-work notices**: an opt-in `--remotes` to include remote-tracking branches from the last fetch (teammates' and cloud agents' pushed branches), still without network access.
- **Concurrent work in the dashboard**: show other branches and worktrees next to this checkout's sessions.
- **`ci-verified`**: verify receipts against GitHub Actions artifact attestations when `trust.ci_provenance: github-attestation` is configured. Until then `ci-verified` cannot be produced, by design (spec §8).
- **Authenticated approval**: a verifiable reviewer identity bound to a claim digest, distinct from `--human` attribution (spec §8.1).
- **Briefing-delivery events**: opt-in, versioned records of what an agent was given, labeled as delivered rather than read, for the dashboard.
- **Historical dashboard views** of the ledger at earlier commits.
- **Retiring old records**: archive closed tasks and their checkpoints so long-lived repositories stay fast to load.
- **Optional tokenizer-accurate budgets**, keeping the characters / 4 estimate as the deterministic default.

## Not planned

These are non-goals (spec §3): replacing Git, storing chat transcripts, orchestrating agents, hosted accounts or databases, and deciding automatically whether a claim is true. `receipt run` runs a single named command in the foreground to observe it; it does not schedule or supervise work.
