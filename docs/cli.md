# Alethic CLI

The command is `alethic` (package `alethic`). Every command works without a model connection. The record format is defined in [spec.md](spec.md).

```console
alethic init [--name <name>]
alethic validate [--json] [--strict]
alethic status [--json] [--all-branches]
alethic session new

alethic task start "<intent>" [--paths <globs...>] [--next <text>] [--human <name>]
alethic task claim <id> [--force]
alethic task update <id> [--status proposed|paused|blocked] [--next <text>]
alethic task close <id> [--status done|abandoned]

alethic decision add --topic <key> --chosen <text> --rationale <text> [--alternative "<option>::<reason>"]...
alethic decision update <id> --status proposed|accepted|superseded
alethic knowledge add --category <category> --body <text> [--summary <text>]
alethic knowledge update <id> --status active|deprecated
alethic receipt run [--paths <globs...>] -- <command> [args...]
alethic receipt add --command "<cmd>" --exit-code <n> [--output-file <path>]

alethic checkpoint create [--task <id>] [--done <text>]... [--failed "<approach>::<why>"]... [--question <text>]... [--next <text>]
alethic checkpoint list [--task <id>] [--json]
alethic checkpoint show <id> [--json]

alethic resume [--task <id>] [--agent <name>] [--target codex|claude-code|gemini|generic] [--budget <tokens>] [--format md|json] [--no-concurrent]
alethic show <id> [--ref <branch or worktree>] [--json]

alethic verify <id> [--human <name> [--note <text>]] [--receipt <id>]...
alethic doctor [--fix] [--strict] [--json]

alethic render agents-md|claude-md|gemini-md [--write | --check]
alethic render pr-summary [--task <id>]
alethic dashboard [--port <n>] [--host <address>] [--snapshot <file>]
alethic mcp
```

Global options:

| Option | Meaning |
|---|---|
| `-C, --cwd <dir>` | Run as if started in `<dir>`, like `git -C`. |
| `-v, --version` | Print the version. |
| `-h, --help` | Show help for any command, e.g. `alethic checkpoint create --help`. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. `validate` found no errors; warnings and info notes are allowed. |
| 1 | `validate` found at least one error, or `task close` refused because the task's records are invalid. |
| 2 | A usage or environment problem: unknown command, missing option, not a Git repository, Alethic not initialized, no agent identity, or a write refused because it would be invalid or leak a secret. |

## Writing records safely

Every command that writes a record:

- needs an agent identity from `--agent <name>` or `ALETHIC_AGENT`;
- validates the record against its schema and scans every field for secrets **before** writing. If anything fails, nothing is written, and secret values are never echoed;
- rejects unsafe paths (absolute, `..`, symlink escapes) and paths matching `privacy.forbidden_globs`;
- checks that referenced records (`--link`, `--receipt`, `--supersedes`, `--task`) exist and are the right kind;
- captures an `anchor`: Git blob ids of cited evidence files first, then files matched by `--paths`, up to `limits.max_fingerprints_per_record` (override with `--max-fingerprints <n>`);
- sets `confidence: agent-reported`, or `human-confirmed` only when `--human <name>` names the person. The confirmation records the name, the agent that recorded it (`recorded_by`), `authentication: none`, and a digest of the claim. The name is an attribution, not an authenticated identity (spec §8.1);
- when an update changes the claim of a `human-confirmed` record (`--summary`), sets it back to `agent-reported` and warns;
- accepts `--json` to print `{ id, file, warnings, ... }`.

Repeatable options (`--done`, `--failed`, `--question`, `--alternative`, `--link`, `--receipt`, `--evidence-file`, `--commit`, `--check`, `--issue`, `--pr`, `--supersedes`) may be given more than once. `--paths` takes one or more values.

**Input from a file.** `checkpoint create`, `decision add`, and `knowledge add` accept `--from-file <path>`, or `--from-file -` for stdin, with the fields as YAML or JSON, so an agent can write a structured record without quoting many flags:

```console
$ alethic checkpoint create --from-file - <<'EOF'
task: task-session-reset
done: [Added token_version]
failed_approaches:
  - approach: Delete session rows
    why_failed: The refresh cache still serves them
open_questions: [Revoke API keys too?]
next_safe_action: Compare token_version in refresh.ts
EOF
```

| Command | Fields |
|---|---|
| `checkpoint create` | `task`, `summary`, `done`, `failed_approaches` (`approach`, `why_failed`), `open_questions`, `next_safe_action`, `receipts`, `links` |
| `decision add` | `id`, `topic`, `chosen`, `rationale`, `summary`, `status`, `alternatives` (`option`, `rejected_because`), `paths`, `links`, `supersedes`, `evidence` (`files`, `commits`, `checks`, `receipts`, `issues`, `prs`) |
| `knowledge add` | `id`, `category`, `body`, `summary`, `paths`, `links`, `evidence` |

Flags given alongside the file override its single values and add to its lists. Unknown fields are refused, and so are fields that set trust or identity (`confidence`, `human`, `created_by`, `owner`, `anchor`, `valid_at`): those come only from flags and the environment. The record goes through the same validation and secret scan as flags.

## `alethic init`

Creates `.alethic/` in the current Git repository:

```text
.alethic/
  manifest.yaml
  .gitignore            # ignores local/
  tasks/ decisions/ knowledge/ checkpoints/ receipts/   (each with .gitkeep)
  local/.gitkeep        # private scratch, never committed
```

- `--name <name>` sets `project.name`. The default is the repository directory name.
- `defaults.default_branch` is guessed from `origin/HEAD`, then a local `main` or `master`, then `init.defaultBranch`.
- Safe to run again: existing files are never overwritten. The manifest is written last, so an interrupted run never leaves a repository that looks initialized but is incomplete.

## `alethic task`

- **`start`** creates an `active` task owned by the current agent, with a lease of `defaults.lease_minutes`. The branch defaults to the current one.
- **`claim`** takes ownership, or renews your own lease. It fails while another agent holds an unexpired lease on an active task; `--force` takes over and says whose lease it overrode. Paused, blocked, and proposed tasks can be claimed by anyone.
- **`update`** sets `paused`, `blocked`, or `proposed`, and changes `next_action` or `summary`. Use `claim` to make a task active and `close` to finish it.
- **`close`** sets `done` (default) or `abandoned`. It first validates the repository and refuses (exit 1) if the task, its checkpoints, or the receipts they cite have errors. An expired lease on the task itself does not block closing.

Closed tasks cannot be claimed, updated, or checkpointed.

## `alethic decision` and `alethic knowledge`

- **`decision add`** records `--topic`, `--chosen`, and `--rationale`, plus rejected alternatives as `"<option>::<reason>"`. The id defaults to `dec-<topic>`. Recording a second decision on the same topic needs `--id`, and `--supersedes <old-id>` when it replaces the old one.
- **`knowledge add`** records a fact with `--category` (`architecture`, `operations`, `convention`, `gotcha`) and `--body`.
- Both accept evidence: `--evidence-file`, `--commit` (a warning if not in the repository), `--check`, `--receipt`, `--issue`, `--pr`.
- **`update`** changes `status` or `summary`.

## `alethic receipt run`

Runs one check and records what it did and the code it ran on. This is the only command that executes anything: it runs the command you name, in the foreground, and does not schedule, retry, or supervise work.

```console
$ alethic receipt run --paths "apps/api/auth/**" -- pnpm test auth
…test output…
Recorded .alethic/receipts/rcpt-pnpm-test-auth-20260913t200200z.yaml (fail, exit 1, observed; no files changed while it ran)
```

- Put the command after `--`. It runs without a shell, in the current directory, with the current environment. Environment variables are never recorded.
- Output streams through as it arrives (to stderr with `--json`, so stdout stays JSON). The receipt keeps the last 4,000 characters, redacted before storage.
- The receipt records the argv, working directory, start and end times, duration, exit code (or signal), and `provenance.capture: observed`.
- Just before and just after the command, it digests the content of every tracked and untracked (not ignored) file outside `.alethic/` and forbidden paths, or only files matching `--paths`. If the digests (or HEAD) differ, the receipt says files changed while it ran. Beyond `limits.max_receipt_files` (default 20,000) files, coverage is recorded as partial, with a warning.
- A command that cannot start is recorded as `error` with exit code 127.
- Exit code: 0 when the check passed and was recorded, 1 when it failed or errored and was recorded, 2 when nothing was recorded (for example, a usage error, or a secret in the command line).
- Confidence is `agent-reported`, or `ci-reported` in CI on a clean tree. Observing the run does not make it `ci-verified`.

Later, `resume` compares the digest with the files as they are then, so an uncommitted edit after the check shows as "files have changed since it ran" even though HEAD did not move.

## `alethic receipt add`

Records the result of a check that **already ran**, as reported. Alethic did not observe it, so the receipt is marked `provenance.capture: imported`, and briefings say "reported to Alethic, not observed". Prefer `receipt run` when you can run the check through Alethic.

```console
$ pnpm test auth > /tmp/auth.log; echo $?
1
$ alethic receipt add --command "pnpm test auth" --exit-code 1 --output-file /tmp/auth.log
Created .alethic/receipts/rcpt-pnpm-test-auth-20260913t200200z.yaml (fail, agent-reported)
```

- `--result` defaults to `pass` for exit code 0, otherwise `fail`. Use `error` when the check could not run properly.
- `--output-file` keeps the last 4,000 characters, starting at a line boundary, after redacting secrets.
- The receipt records the branch, HEAD, and whether the tree was dirty (uncommitted changes outside `.alethic/`).
- With `CI=true` and a clean tree, confidence is `ci-reported` and `provenance.source` is `ci-env`, with the GitHub Actions run URL when available. That is still a self-report (spec §8). No command can produce `ci-verified`.

## `alethic checkpoint`

**`create`** writes an append-only snapshot for the next agent:

- **Task:** `--task`, or your single active task, or the single active task on this branch.
- **Git:** branch, HEAD, dirty, `base` (merge-base with `defaults.default_branch`), and `changed_paths` since base, including uncommitted and untracked files, excluding `.alethic/` and forbidden paths.
- **Receipts:** those named with `--receipt`, plus receipts any agent recorded since the task's last checkpoint (or since the task started) whose `git.head` is on the current line of history. Evidence recorded before a handoff carries over; receipts from unrelated branches do not.
- **`next_safe_action`:** `--next`, else the task's `next_action`, else `Not determined: review open_questions and failed_approaches before acting.` A checkpoint is never refused for lack of a next step, since stopping without one is worse.

**`list`** shows checkpoints newest first. **`show`** prints the checkpoint with its task's intent and each cited receipt's result; `--json` returns `{ checkpoint, task, receipts }`.

A typical handoff:

```console
$ alethic checkpoint create --done "Added token_version" \
    --failed "Delete session rows::Refresh tokens are cached" --next "Compare token_version in refresh.ts"
$ alethic task update task-session-reset --status paused
$ git add -A && git commit -m "wip: checkpoint" && git push

# The next agent, in a fresh session:
$ alethic status
$ alethic checkpoint show $(alethic checkpoint list --task task-session-reset --json | jq -r '.[0].id')
$ alethic task claim task-session-reset
```

## `alethic resume`

Compiles a briefing for the next agent from records and the current Git state. Sections always appear in this order:

1. **Goal**: the task's intent, status, and owner.
2. **Current repository state**: branch, HEAD, dirty, changes since base, and how far HEAD has moved since the latest checkpoint, including whether any code outside `.alethic/` changed.
   - **Integrity warnings**, only when needed: records withheld because they failed validation (named by file and finding code only), files that could not be loaded, references that cannot be followed, and contradictory accepted decisions that touch the task. Always shown in full, at most five items of each kind.
   - **Concurrent work on other branches**, only when needed: other local branches and worktrees that changed files in the task's scope, or recorded tasks, decisions, knowledge, or checkpoints about it, since they split from this branch (spec §12.1). Always shown in full but capped: at most three sources, two record lines, and a pointer to `alethic status --all-branches` for the rest.
3. **Relevant architecture and decisions**: decisions and knowledge. Decisions in a contradiction are marked `⚠ disputed`.
4. **Files changed or likely relevant**: task scope, changes on this branch, and paths changed at the latest checkpoint.
5. **Verified behavior and checks run**: receipts, noting whether they ran on HEAD, on a commit with the same code, or on code that has changed since.
6. **Failed approaches**: from every checkpoint for the task, newest first.
7. **Open questions**: from the latest checkpoint.
8. **Next safe action**: from the latest checkpoint, else the task.

Options:

- `--task <id>`: defaults to the active task owned by `--agent` or `ALETHIC_AGENT`, else the single open task on the current branch, else the single open task.
- `--budget <tokens>`: an **approximate** size, estimated as characters / 4 (default `defaults.budget`). Real tokenizer counts vary by model. Goal, repository state, and next safe action are always included in full. Other items shrink to one-line summaries, then to `N more: [ids]` pointers, which cite at most five records and count the rest. Every non-empty section keeps at least its top item before any section gets a second one, and a lower-ranked item is never shown while a higher-ranked item in the same section is hidden. When space is short, items are kept in this order: failed approaches, open questions, checks, decisions and knowledge, then files.
- `--target`: `codex`, `claude-code`, `gemini`, or `generic`. Only the header and footer change; the content is identical for every target.
- `--agent <name>`: the agent reading the briefing, used to find its active task (default `ALETHIC_AGENT`).
- `--no-concurrent`: leave out work on other branches and worktrees, and skip reading them. Reading worktrees needs Git 2.36 or later (`git worktree list -z`); with older Git, other worktrees are skipped and only branches are read.
- `--format json`: `{ task, target, budget, tokens, overBudget, report, sections[{ key, title, items[{ key, level, text, record?, reasons?, score?, freshness?, applicability? }] }], skipped[{ id, reason }], concurrent[{ source, branch?, worktree?, committedAt?, base, uncommitted, paths[], records[{ id, kind, uncommitted }], withheld }] }`. This is the compiler's inspectable result: every item is listed with the level it got (`full`, `short`, or `pointer` when it was collapsed into an "N more" line), and items from records say which record, how it was found (`reasons`), its score, and its derived freshness. `skipped` lists retired records that matched but were left out. `report` attributes the approximate tokens: `frame`, `required` (headings and sections that are never shortened), `optional`, and `pointers`, with the overflow `policy`.
- Overflow: goal, repository state, integrity warnings, concurrent work, and next safe action are never shortened, even when they alone exceed the budget. The command still prints the briefing and warns on stderr, saying how much the mandatory content and the pointer lines take.
- Every collapsed record can be read with `alethic show <id>`, and the briefing's footer says so.

How records are chosen (deterministic, no embeddings):

- records linked from the task or its checkpoints, and records whose `links` name the task;
- receipts cited by the task's checkpoints or by chosen decisions and knowledge, receipts recorded at HEAD since the task started, and receipts recorded on this line of history since the latest checkpoint (the ones the next checkpoint would attach);
- decisions and knowledge whose `scope.paths` or evidence files match the task scope, the branch's changed paths, or the checkpoints' changed paths;
- superseded decisions and deprecated knowledge only when explicitly linked.

They are ranked by how they were found (explicit links first), trust level (`ci-reported` counts the same as `agent-reported`), accepted status, whether their anchor is on this line of history, and, for receipts, whether the code is unchanged since they ran; then recency and id. Staleness never lowers a record's rank: a record that may be stale is shown with its warning rather than hidden. Within their section, records that may be stale are listed first, so their warnings survive small budgets.

Every bullet ends with its source: a record id like `[dec-auth-session-invalidation]`, a record on another branch like `[dec-auth-refresh-shape on feat/token-refresh]`, `(receipt rcpt-…)`, or `(commit abc1234)`. Records from other branches carry trust markers but no freshness markers, which describe this checkout's code. Claims that are not `human-confirmed` or `ci-verified` are marked `⚠ unverified`. Records whose direct evidence changed by any amount are marked `⚠ may be stale: <reason>`, with `(small change)` when the change is within `staleness.changed_lines_threshold`. Records whose applicability cannot be established are marked `⚠ applicability unknown: <reason>`, and records whose cited files are unchanged while nearby files matched by a scope glob changed get `ℹ nearby files changed, cited files did not: <reason>` (spec §9).

## `alethic show`

Prints one record with what is derived about it. Use it to read an item a briefing collapsed into an "N more" line.

```console
$ alethic show dec-auth-session-store
# dec-auth-session-store (decision)

File:      .alethic/decisions/dec-auth-session-store.yaml
Revision:  5b2f0c1e9d…
Freshness: needs_reverification: apps/api/auth/session.ts changed 2 lines (+1/-1) since it was anchored
Trust:     human-confirmed by Priya (attributed, recorded by codex; not authenticated)

---
id: dec-auth-session-store
…
```

- `Revision` is the Git blob id of the record file.
- `Freshness` is the derived status and its reasons (spec §9), `Trust` the confidence and, for human confirmations, whether the confirmation is bound to this text (§8.1). Receipts add `Applies`: whether the result applies to the current code, and whether it was observed or reported (§6.5).
- Record-level findings, such as an outdated confirmation, are listed before the record.
- `--json` prints `{ id, kind, file, revision, record, derived: { staleness, confirmation, receipt? }, findings }`.
- Records that failed validation are refused (exit 2), so a secret in a hand-edited record is never printed.
- `--ref <branch or worktree>` reads the record from another local branch, or from another worktree of this clone (by path, or by the branch checked out there), as a concurrent-work notice cites it. It passes the same checks with this checkout's privacy settings. Freshness and applicability are not judged, since they describe this checkout's code; `--json` adds `source { name, branch?, tip, worktree? }` and `derived` has only `confirmation`.

## `alethic render`

**Instruction files.** `render agents-md`, `render claude-md`, and `render gemini-md` maintain a short block between `<!-- alethic:begin -->` and `<!-- alethic:end -->` in `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. The block tells the agent to start from `alethic resume`, record receipts and checkpoints, keep private content out of records, and validate before closing.

- Without options, it prints the block and writes nothing.
- `--write` creates the file, appends the block, or replaces the existing block. Text outside the markers is never changed, and CRLF line endings are kept. Running it again changes nothing.
- `--check` exits 1 when the file is missing or its block differs. Use it in CI.
- Malformed markers (a begin without an end, or two blocks) are refused with exit 2 rather than guessed at.
- `claude-md` and `gemini-md` change nothing when the file imports `@AGENTS.md` and `AGENTS.md` already has the block. They refuse to write through a symlink to `AGENTS.md`, and no file is written through a symlink that leaves the repository.

Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`, and Gemini CLI reads `GEMINI.md` unless configured otherwise. Per-agent setup: [Codex](adapters/codex.md), [Claude Code](adapters/claude-code.md), [Gemini CLI](adapters/gemini.md).

**Pull request summary.** `render pr-summary` prints a Markdown description for a task (`--task`, or inferred as for `resume`). It includes the intent and status, decisions, the latest receipt for each command, failed approaches, open questions, and the next step, and each item cites its record. It reports recorded results and never re-runs them.

```console
$ alethic render pr-summary | gh pr create --title "Invalidate sessions after password reset" --body-file -
```

## `alethic dashboard`

Serves a read-only page on this machine that shows sessions, records, inferred handoffs, briefings, and health. See [dashboard.md](dashboard.md).

```console
$ alethic dashboard --port 0
Alethic dashboard: http://127.0.0.1:53211/
Read-only, and reachable only from this machine. Press Ctrl+C to stop.
```

- `--port <n>`: default 4700; `0` picks a free port. `--host`: `127.0.0.1` (default), `::1`, or `localhost`; other addresses are refused.
- `--snapshot <file>`: write the page's data as JSON (`-` for stdout) and exit. Records that fail validation are withheld from it, as from the page.
- The server answers only `GET` and `HEAD`, rejects requests addressed to other host names, sends a strict Content-Security-Policy, and never writes records or runs commands.

## `alethic session new`

Prints a fresh session id, prefixed with `--agent` or `ALETHIC_AGENT`: `export ALETHIC_SESSION=$(alethic session new)`. Records and task owners then carry the session, so two runs of the same agent are different writers (spec §12).

## `alethic mcp`

Runs a Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, protocol versions 2024-11-05 through 2025-11-25. Stdout carries only protocol messages, and diagnostics go to stderr. The server exits when the client closes stdin.

| Tool | Runs |
|---|---|
| `resume` | `resume` (Markdown briefing) |
| `status` | `status --json` |
| `validate` | `validate --json`. Findings are a normal result, not a tool error. |
| `task_start` | `task start` |
| `task_claim` | `task claim` |
| `checkpoint_create` | `checkpoint create`, with `failed_approaches` as `{ approach, why_failed }` objects |
| `receipt_record` | `receipt add`, with the command's output passed as `output` text |
| `decision_add` | `decision add`, with `alternatives` as `{ option, rejected_because }` objects |
| `knowledge_add` | `knowledge add` |

Resources: `alethic://status` (JSON), and `alethic://records/{id}` for any record's YAML. Open tasks are listed.

- Every tool call runs the matching CLI command in-process, one call at a time. Schema validation, path safety, reference checks, and the secret scan are therefore the same as on the command line. A refused write comes back as a tool error (`isError: true`) with the CLI's message.
- Arguments are checked against each tool's input schema first, and unknown properties are refused.
- No tool takes a `human` argument, so nothing written over MCP can be `human-confirmed`.
- Identity comes from `ALETHIC_AGENT` in the server's environment, or from an `agent` argument.
- The repository is `-C <dir>` if given, else `CLAUDE_PROJECT_DIR`, else the working directory.

## `alethic validate`

Checks every record against the rules in [spec.md §16](spec.md#16-validation-summary). Findings are printed as:

```text
error   .alethic/tasks/task-abandoned.yaml:owner.lease_expires_at: Lease held by codex expired at 2026-09-13T20:00:00Z
        hint: Renew with `alethic task claim task-abandoned`, or hand off: write a checkpoint and set status: paused.

✗ 1 error, 0 warnings in 2 records
```

- `--json` prints `{ valid, errors, warnings, records, findings[] }`. Each finding has `severity`, `code`, `file`, `path`, `message`, and `hint`.
- `--strict` turns missing evidence commits into errors. Without it they are warnings, because squash merges and shallow clones legitimately remove commits.

Finding codes:

| Code | Severity | Meaning |
|---|---|---|
| `manifest-missing` | error | `.alethic/manifest.yaml` does not exist. |
| `manifest-pattern` | error | An entry in `privacy.extra_secret_patterns` is not a valid regular expression. |
| `yaml` | error | Unparseable YAML, or anchors, aliases, custom tags, duplicate keys, or multiple documents. |
| `wrong-extension` | error | A record file ends in `.yml` instead of `.yaml`. |
| `unexpected-file` | warning | A non-record file or directory inside a record directory. |
| `schema` | error | The record does not match its JSON Schema. |
| `id-mismatch` | error | The `id` does not match the file name. |
| `kind-mismatch` | error | The `kind` does not match the directory the file is in. |
| `duplicate-id` | error | Two files use the same id. |
| `dangling-reference` | error | `links`, `task`, `receipts`, `evidence.receipts`, or `supersedes` names a record that does not exist. |
| `wrong-reference-kind` | error | A reference points at the wrong kind of record, such as a checkpoint's `task` naming a decision. |
| `secret` | error | A field looks like a credential. The value is never printed. |
| `expired-lease` | error | An `active` task's ownership lease has expired. |
| `untrusted-confidence` | error | `ci-verified` without verifiable CI provenance. |
| `forbidden-path` | error | A cited path matches `privacy.forbidden_globs`. |
| `unsafe-path` | error | A path resolves outside the repository through a symlink. Lexically unsafe paths (absolute, `..`) are reported as `schema`. |
| `missing-evidence-file` | error | An `evidence.files` path does not exist in the working tree. |
| `missing-commit` | warning (error with `--strict`) | An evidence commit, `git.head`, or `git.base` is not in the repository. |
| `unavailable-commit` | info | `valid_at` or `anchor.commit` is not in the repository. Expected after squash merges; never a failure. |
| `append-only` | error | A committed checkpoint or receipt was edited. |
| `needs-reverification` | warning | An active decision's or knowledge record's direct files changed by any amount, or files were added to a scope with no direct files (spec §9). The message gives the size; `staleness.changed_lines_threshold` only labels it small or large. |
| `uncertain-applicability` | warning | An anchored decision or knowledge record cites evidence that has no fingerprint, so changes to it cannot be detected. |
| `diverged` | warning | The record was anchored on another line of history, and the content here differs. |
| `contradiction` | warning | Two accepted decisions on the same topic have overlapping scopes, and neither supersedes the other (spec §11). |
| `confirmation-outdated` | warning | A `human-confirmed` record's claim was edited after the latest confirmation, so it counts as `agent-reported` until someone confirms it again (spec §8.1). |

A deleted evidence file is reported once, as `missing-evidence-file`, rather than also as stale.

## `alethic verify`

Re-anchors a decision, knowledge record, or task to HEAD after someone checked that it still holds. It rewrites `valid_at`, `anchor`, and `updated_at`, so the check appears as a diff (spec §8 rule 3, §9).

```console
$ alethic verify dec-auth-refresh-cache --human "Priya" --note "Read refresh.ts after the rewrite"
Updated .alethic/decisions/dec-auth-refresh-cache.yaml
Verified dec-auth-refresh-cache at 4b1e9c2
  was: needs_reverification: apps/api/auth/refresh.ts changed 41 lines (+40/-1) since it was anchored
  confidence: human-confirmed (confirmed by Priya)
  anchor: 4 files fingerprinted
```

- `--human <name>` sets `human-confirmed` and appends an `evidence.human` entry with the name, `recorded_by` (the agent running the command), `authentication: none`, and a `claim_digest` of the current claim. `--note` records what the person checked. The name is not authenticated: anyone who can run the CLI can pass any name, and briefings say so (spec §8.1).
- Without `--human`, a confirmation whose claim was edited after it was made is not kept, even if the code is unchanged.
- Without `--human`, confidence becomes `agent-reported`, unless the anchored content is unchanged. In that case an existing `agent-reported`, `ci-reported`, or `human-confirmed` label is kept. A confirmation made against older code is never carried forward onto code that has changed. `inferred` becomes `agent-reported`.
- No command can produce `ci-verified`.
- `--receipt <id>` adds supporting receipts to `evidence.receipts`.
- Refused: checkpoints and receipts (append-only), superseded or deprecated records, closed tasks, and records whose evidence files no longer exist.

## `alethic doctor`

Runs everything `validate` checks, plus coordination checks that only `doctor` reports:

| Code | Severity | Meaning |
|---|---|---|
| `overlapping-claim` | warning | Two active tasks with unexpired leases, held by different writers (different agents, or two recorded sessions of one agent), over overlapping paths. |
| `competing-claim` | warning | A checkpoint written by a different writer while the task's current owner held its lease, typically after merging branches that both worked the task. Names both writers and sessions. |
| `orphaned-checkpoint` | warning | A checkpoint written after its task was closed, typically from merging branches. Its next action may be unfinished work. |
| `superseded-still-accepted` | warning | A decision named in an accepted decision's `supersedes` that is still `accepted` or `proposed`. |

Scopes overlap when they share a pattern, when one names a path the other matches, or when both match a tracked file. A decision with no scope overlaps everything on its topic.

- Each finding carries its hint. In `--json` output it also carries `command` (the suggested command, when there is one) and `fixable`.
- `--fix` applies only mechanical fixes, then reports what remains. It pauses active tasks whose lease expired (the owner stays on record), and marks decisions `superseded` when an accepted decision already supersedes them. Anything that needs judgment, such as contradictions, stale claims, or overlapping claims, is left to the suggested command. `--fix` needs an agent identity.
- Exit code 1 when errors remain, 0 otherwise. `--json` prints `{ ok, errors, warnings, fixed[], findings[] }`.

## `alethic status`

Shows the branch, HEAD, and dirty state (changes under `.alethic/` don't count as dirty), record counts, active tasks with their owners, leases, next actions, and latest checkpoints, other open tasks, and a validation summary. It always exits 0 once Alethic is initialized; run `validate` for details.

`--json` prints `{ project, git, counts, activeTasks[], openTasks[], validation }`.

`--all-branches` adds work on other local branches and worktrees since each split from this branch (spec §12.1), whether or not it touches a task: changed files, tasks, decisions, knowledge, counts of checkpoints and receipts, whether anything in a worktree is uncommitted, and how many records there failed validation. Branches merged into HEAD are not listed; branches with no shared history are named as skipped. In JSON: `concurrent: { sources[{ source, branch, worktree, committedAt, tip, base, uncommitted, changedPaths[], tasks[], decisions[], knowledge[], checkpoints, receipts, withheld }], unrelated[], omitted }`.

## Environment variables

| Variable | Meaning |
|---|---|
| `ALETHIC_AGENT` | Agent identity for commands that write records, such as `codex`, `claude-code`, or `gemini`. `--agent` takes precedence. |
| `ALETHIC_SESSION` | The session of that agent, recorded in `created_by.session` and `owner.session`, so two runs of the same tool are different writers. `alethic session new` prints a fresh id. `alethic mcp` generates one per connection when unset. |
| `ALETHIC_MODEL` | The model behind the session, recorded in `created_by.model`. Only set it when you know it; nothing guesses it. |
| `ALETHIC_NOW` | Fixed current time (for example `2026-09-13T21:00:00Z`), for reproducible tests and demos. |
| `ALETHIC_DEBUG` | Print stack traces for unexpected failures. |
| `CI` | When `true` (or `1`) and the tree is clean, receipts are labeled `ci-reported`. |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code for the MCP servers it starts. `alethic mcp` uses it as the repository when `-C` is not given. |

## CI

Validate records on every pull request with the bundled action:

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0 # full history, so evidence commits can be checked
- uses: shubhambaid/alethic@main
  with:
    strict: "true"
```

Inputs: `working-directory` (default `.`) and `strict` (default `"false"`). Lease expiry is checked against the real clock, so a task abandoned while `active` fails CI until someone renews it or pauses it.
