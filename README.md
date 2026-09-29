# Alethic

Verifiable context for coding agents.

Alethic keeps the state of unfinished work in the repository: tasks, decisions, knowledge, checkpoints, and check receipts, as small YAML files under `.alethic/`. When one agent stops, the next one (Codex, Claude Code, Gemini, or a person) picks up from what was committed, without the previous chat history.

<!-- Demo GIF goes here. Generate it with `vhs examples/demo/demo.tape` (writes docs/assets/demo.gif). -->

## Why

When an agent session ends, most of what it learned ends with it: which approach failed and why, what was decided, which tests ran against which commit. The next agent rediscovers it, or repeats the failed approach.

Alethic records that as reviewable files committed with the code, and compiles them into a short, cited briefing for whoever continues.

- **Plain files in Git.** One record per file, so they show up in pull requests and merge like code. No service, account, database, or network access.
- **Anchored to code.** Records fingerprint the files they describe. When that code changes, the record is flagged *may be stale* instead of being trusted silently. Fingerprints are content-based, so records survive squash merges, rebases, and shallow clones.
- **Honest trust labels.** Agent claims are marked *unverified*. A human confirmation is shown as an attribution ("confirmed by Priya, as recorded by codex; not authenticated"), bound to the exact text confirmed, and flagged when that text changes. Setting `CI=true` does not make anything verified. Labels describe provenance, not identity: see the [trust boundary](docs/spec.md#81-trust-boundary).
- **Agent-neutral.** A CLI any agent can run, short instruction blocks for `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`, and an MCP server.
- **Private by default.** Records are scanned for credentials before they are written, and transcripts and customer data do not belong in them.

## See a handoff

```sh
npm install && npm run build
examples/demo/run-demo.sh
```

The script builds a tiny auth service in a temporary directory, then hands one task through three agents: Codex tries an approach that fails, Claude Code resumes from the briefing and fixes it, and Gemini runs the full suite and closes the task. It takes a few seconds and is run by the test suite, so it stays accurate. Here is part of the briefing Claude Code starts from, compiled only from Codex's records (abridged; run the script for the full output):

```text
## Verified behavior and checks run
- `node --test` failed (exit 1) at 87e0b47 (code unchanged since), 2026-09-14T09:40:00Z; … (receipt rcpt-node-test-20260914t094000z) ⚠ unverified

## Failed approaches
- Delete session rows on reset. Failed because: refresh() reads the refresh cache first, so cached sessions keep working. [cp-invalidate-sessions-after-password-reset-20260914t094000z] ⚠ unverified

## Next safe action
- Bump users.tokenVersion on reset and compare it in refresh(). [cp-invalidate-sessions-after-password-reset-20260914t094000z]
```

## See the work in the dashboard

`alethic dashboard` serves a read-only page on this machine: one lane per agent session, the records each session wrote, the handoffs between them, and everything that needs attention. Here it shows the demo repository after an uncommitted edit to `src/sessions.js`: the decision the edit contradicts is flagged, its inspector compares the anchored and current content file by file, and the recorded checks no longer claim to apply.

![Alethic dashboard: session lanes with records and inferred handoffs, and an inspector showing a decision whose evidence changed](docs/assets/dashboard.png)

Every relationship says whether a record states it or it was inferred, and nothing in the dashboard claims that an agent read a record. Details: [docs/dashboard.md](docs/dashboard.md).

## Quickstart

Alethic is not published to npm yet. Install it from source (Node 22.12 or later):

```sh
git clone https://github.com/shubhambaid/alethic.git
cd alethic && npm install && npm run build && npm link   # puts `alethic` on PATH
```

In your repository:

```sh
alethic init
alethic render agents-md --write     # tell agents to start from `alethic resume`
git add -A && git commit -m "Add Alethic"
```

An agent (or you) starts work and leaves a checkpoint before stopping:

```sh
export ALETHIC_AGENT=codex
alethic task start "Sessions issued before a password reset stop working" --paths "src/auth/**"
npm test > test.log; alethic receipt add --command "npm test" --exit-code $? --output-file test.log
alethic checkpoint create --failed "Delete session rows::the refresh cache still serves them" \
  --next "Compare a token version on refresh"
alethic task update <task-id> --status paused
git add -A && git commit -m "wip: session reset"
```

The next agent, in a fresh session:

```sh
export ALETHIC_AGENT=claude-code
alethic resume --budget 2500         # cited briefing; the budget is approximate (characters / 4)
alethic task claim <task-id>
```

Before merging, `alethic validate` checks every record, and `alethic doctor` also looks for stale claims, contradictory decisions, and overlapping claims.

## What is stored

| Record | Holds | Example id |
|---|---|---|
| Task | Intent, scope, owner with an expiring lease, next action | `task-invalidate-sessions-after-password-reset` |
| Decision | What was chosen, why, and rejected alternatives | `dec-auth-session-invalidation` |
| Knowledge | A durable fact: architecture, operations, convention, or gotcha | `kn-refresh-reads-the-cache-first` |
| Checkpoint | Git state, what was done, failed approaches, open questions, next safe action (append-only) | `cp-invalidate-sessions-…-20260914t094000z` |
| Receipt | A check that already ran: command, exit code, commit, redacted output tail (append-only) | `rcpt-node-test-20260914t094000z` |

Every record carries a confidence label, an anchor to the code it describes, and evidence links. The format is specified in [docs/spec.md](docs/spec.md) and enforced by JSON Schemas in [schemas/](schemas/).

## Commands

| Command | Purpose |
|---|---|
| `init`, `status`, `validate` | Set up, inspect, and check `.alethic/` |
| `task start / claim / update / close` | Own work with expiring leases |
| `decision add / update`, `knowledge add / update` | Record choices and facts |
| `receipt run`, `receipt add` | Run a check and record the code it saw, or record a check that already ran |
| `checkpoint create / list / show` | Hand off unfinished work |
| `resume` | Compile a cited, budgeted briefing for the next agent |
| `show` | Read one record with its derived freshness and trust |
| `verify`, `doctor` | Re-anchor checked claims; find stale records and conflicts |
| `render` | Instruction-file blocks and pull request summaries |
| `mcp` | Serve the same operations over MCP (stdio) |
| `dashboard` | Explore sessions, records, handoffs, and health in a local read-only page |
| `session new` | Print an id for `ALETHIC_SESSION`, so runs of one agent are told apart |

Full reference: [docs/cli.md](docs/cli.md).

## Agent setup

- [Codex](docs/adapters/codex.md)
- [Claude Code](docs/adapters/claude-code.md)
- [Gemini CLI](docs/adapters/gemini.md)

## Documentation

- [Specification](docs/spec.md): the record format, trust levels, staleness, merge behavior, and privacy boundary
- [CLI reference](docs/cli.md)
- [Architecture](docs/architecture.md)
- [Why not just AGENTS.md?](docs/why-not-agents-md.md)
- [How Alethic compares](docs/comparison.md)
- [Briefing performance on large ledgers](docs/performance.md)
- [Evaluating handoffs in real agent sessions](docs/evaluation.md): the protocol, and what has not been verified yet
- [Roadmap](ROADMAP.md) and [contributing](CONTRIBUTING.md)

## Status

Pre-release (v0). The record format is versioned (`schema_version: 1`) and covered by tests, but it may still change before the first published release.

## License

[Apache-2.0](LICENSE)
