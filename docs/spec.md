# Alethic Specification — format v1

> Verifiable context for coding agents.
> Git versions code. Alethic versions the context needed to change it safely.

Status: draft for v0. This document is normative. The words MUST, MUST NOT, SHOULD, and MAY carry their usual RFC 2119 meaning. The JSON Schemas in [`schemas/`](../schemas) are the machine-readable form of the rules here. If this document and the schemas disagree, that is a bug, and the test suite is built to catch it (see [Appendix A](#appendix-a-machine-checked-examples)).

## 1. Problem

Coding agents such as Codex, Claude Code, and Gemini/Antigravity each work in isolated sessions with their own private memory. When work moves from one agent to another, or from Monday's session to Tuesday's, the next agent has to rebuild the context from code, `git log`, and whatever chat transcript it can find:

- what the work is for;
- what has already been decided, and why;
- which approaches were tried and failed;
- which tests actually ran, on which code;
- what is still unknown;
- what the next safe step is.

Today that context lives in chat history, which is private, huge, and vendor-specific, or in ad-hoc handoff Markdown, which is unstructured, unverifiable, and silently goes stale. Agents repeat investigations, contradict earlier decisions, and trust test results that no longer apply.

Alethic stores that context as small, typed, reviewable records inside the repository, versioned by Git alongside the code they describe.

## 2. Principles

1. **Git-native.** Shared state lives in the repository and moves through ordinary branches, commits, reviews, and merges. There is no server.
2. **Evidence over assertion.** Important records link to commits, files, checks, receipts, issues, PRs, or human confirmations. A claim with no evidence is labeled as such.
3. **Portable by default.** The format is plain YAML plus JSON Schema. It depends on no model, IDE, CLI, or vendor.
4. **Small context, not transcript dumps.** Agents receive a task-specific briefing within an approximate size budget, not the whole store.
5. **Human-readable and machine-validatable.** A developer can read and hand-edit every record without Alethic installed, and CI can validate them without a model.
6. **Private by design.** Raw transcripts, credentials, customer data, and model-private memories never enter committed state.

## 3. Non-goals (v0)

- Replacing Git, issue trackers, or ADR processes.
- Storing chat transcripts or reasoning traces, in full or in part.
- Orchestrating agents: scheduling, running, or supervising them, or executing work on their behalf. The one command that runs anything is `alethic receipt run`, which runs a single command the caller names, in the foreground, only to observe its result and the code it ran on (§6.5). It does not schedule, retry, or supervise.
- Hosted accounts, billing, sync services, or a central database.
- Inferring "truth" from agent output automatically. Alethic records who claimed what, with what evidence, and at what trust level. It never upgrades a claim on its own.
- Semantic/embedding search. Retrieval is deterministic.

## 4. File layout

```text
.alethic/
  manifest.yaml          # project settings (§7)
  .gitignore             # ignores local/
  tasks/                 # task-*.yaml
  decisions/             # dec-*.yaml
  knowledge/             # kn-*.yaml
  checkpoints/           # cp-*.yaml    (append-only)
  receipts/              # rcpt-*.yaml  (append-only)
  local/                 # NOT committed: private scratch for one machine
```

Rules:

- One record per file. The file name MUST be `<id>.yaml`, in the directory for its kind. One file per record keeps merge conflicts rare and diffs readable.
- Files are UTF-8 YAML 1.2. Tools MUST NOT depend on YAML features beyond plain mappings, sequences, and scalars: no anchors, aliases, or custom tags.
- Commit ids and other hex strings SHOULD be quoted (`"83fa2de"`). An unquoted all-digit sha such as `1234567` parses as a number and fails validation.
- Nothing under `local/` is ever read by `resume`, rendered, or committed.

## 5. Record envelope

Every record (task, decision, knowledge, checkpoint, receipt) shares these fields:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `<prefix>-<slug>`: lowercase letters, digits, and single hyphens, at most 120 chars. Prefixes: `task-`, `dec-`, `kn-`, `cp-`, `rcpt-`. |
| `kind` | yes | `task` \| `decision` \| `knowledge` \| `checkpoint` \| `receipt` |
| `schema_version` | yes | `1` |
| `summary` | yes | One line, at most 280 characters. Written for a busy reader. |
| `status` | yes | Lifecycle state. Allowed values depend on the kind (§6). |
| `confidence` | yes | Trust level (§8). |
| `created_by` | yes | `{agent, session?, model?, human?}`. `agent` is a lowercase tool name such as `codex`, `claude-code`, `gemini`, or `human`. `session` identifies one run of that tool, so two sessions of the same tool are different writers (§12). `model` is recorded only when the caller states it. `human` is a name the writer attributes the record to, not an authenticated identity (§8.1). |
| `created_at` | yes | UTC timestamp ending in `Z`. |
| `updated_at` | no | UTC timestamp of the last edit. |
| `valid_at` | no | Commit id the record was true at, for humans and ancestry hints (§9). |
| `anchor` | no | Content fingerprints used for staleness detection (§9). |
| `scope.paths` | no | Repository-relative paths or globs the record is about (§10). |
| `links` | no | Ids of related records. |
| `evidence` | no | `commits`, `files`, `checks`, `receipts`, `issues`, `prs`, `human` (§8). |
| `supersedes` | no | Ids of records this one replaces. |

Unknown fields are rejected, and extensions require a new `schema_version`. Checkpoint and receipt ids SHOULD end in a UTC timestamp (`-20260913t201500z`) so that parallel writers never collide.

A note on the brief's `status: verified`: in Alethic, *verification is a trust level*, not a lifecycle status. A decision is `status: accepted` with `confidence: human-confirmed`, for example.

## 6. Record kinds

### 6.1 Task

A unit of intended work: what it is for, who holds it, and what comes next.

- `status`: `proposed` → `active` → `paused` | `blocked` → `done` | `abandoned`
- `intent` (required): what should be true when the task is done, and why.
- `branch`: the branch where the work happens.
- `owner`: `{agent, claimed_at, lease_expires_at}`. It is required when `status: active` (see §12).
- `next_action`: the next concrete step.

<!-- alethic:schema=task -->
```yaml
id: task-session-reset-invalidation
kind: task
schema_version: 1
summary: Invalidate existing sessions when a user resets their password.
status: active
confidence: human-confirmed
created_by:
  agent: codex
  human: maintainer
created_at: "2026-09-13T18:02:00Z"
updated_at: "2026-09-13T20:15:00Z"
intent: >-
  After a password reset, every session and refresh token issued before the reset
  must stop working within one request, so a stolen session cannot outlive a reset.
branch: feat/session-reset
scope:
  paths:
    - apps/api/auth/**
    - apps/api/db/migrations/**
owner:
  agent: codex
  claimed_at: "2026-09-13T18:02:00Z"
  lease_expires_at: "2026-09-13T22:02:00Z"
next_action: Make refresh-token validation compare token_version.
evidence:
  issues:
    - "#412"
  human:
    - name: maintainer
      at: "2026-09-13T18:00:00Z"
      note: Scope agreed in issue #412.
```

### 6.2 Decision

A choice that later work must respect: what was chosen, why, and what was rejected.

- `status`: `proposed` | `accepted` | `superseded`
- `topic` (required): a stable dotted key for *what* is being decided, such as `auth.session-invalidation`. Two `accepted` decisions with the same topic and overlapping scope conflict unless one `supersedes` the other (§11).
- `chosen` (required), `rationale` (required), `alternatives`: `[{option, rejected_because}]`.

<!-- alethic:schema=decision -->
```yaml
id: dec-auth-session-rotation
kind: decision
schema_version: 1
summary: Rotate user sessions on password reset by bumping a per-user token version.
status: accepted
confidence: human-confirmed
topic: auth.session-invalidation
chosen: Store token_version on users, embed it in session and refresh tokens, and reject mismatches.
rationale: >-
  A single increment revokes every session and cached refresh token without scanning
  Redis, and it holds even while refresh tokens sit in the 15-minute cache.
alternatives:
  - option: Delete all session rows on reset.
    rejected_because: Cached refresh tokens in Redis stay valid for up to 15 minutes.
  - option: Scan and evict Redis keys per user.
    rejected_because: Keys are not indexed by user, and SCAN over the production cache is too slow.
created_by:
  agent: claude-code
  human: maintainer
created_at: "2026-09-13T21:10:00Z"
valid_at: "83fa2de"
scope:
  paths:
    - apps/api/auth/**
links:
  - task-session-reset-invalidation
  - kn-refresh-tokens-cached-in-redis
evidence:
  commits:
    - "83fa2de"
  checks:
    - pnpm test auth/session-reset
  receipts:
    - rcpt-auth-tests-20260913t200200z
  human:
    - name: maintainer
      at: "2026-09-13T21:12:00Z"
      note: Approved in PR review.
anchor:
  commit: "83fa2de5b0c4a1d2e3f40516273849506a7b8c9d"
  fingerprints:
    apps/api/auth/session.ts: "8f94139338f9404f26296befa88755fc2598c289"
    apps/api/auth/refresh.ts: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
```

### 6.3 Knowledge

A durable architectural or operational fact that is useful beyond one task.

- `status`: `active` | `deprecated`
- `category` (required): `architecture` | `operations` | `convention` | `gotcha`
- `body` (required): the fact, with enough detail to act on.

<!-- alethic:schema=knowledge -->
```yaml
id: kn-refresh-tokens-cached-in-redis
kind: knowledge
schema_version: 1
summary: Refresh tokens are cached in Redis for 15 minutes, so database changes alone do not revoke them.
status: active
confidence: agent-reported
category: gotcha
body: >-
  apps/api/auth/refresh.ts reads refresh-token sessions from Redis (key auth:rt:<id>,
  TTL 900s) before falling back to Postgres. Revocation logic must also invalidate or
  outvote the cached entry.
created_by:
  agent: codex
created_at: "2026-09-13T20:05:00Z"
valid_at: "9c1e4b7"
scope:
  paths:
    - apps/api/auth/refresh.ts
    - apps/api/cache/**
evidence:
  files:
    - apps/api/auth/refresh.ts
  receipts:
    - rcpt-auth-tests-20260913t200200z
anchor:
  commit: "9c1e4b7d2f0a8e6b5c4d3e2f1a0b9c8d7e6f5a41"
  fingerprints:
    apps/api/auth/refresh.ts: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
```

### 6.4 Checkpoint

A compact, append-only handoff snapshot for unfinished work. A checkpoint is written for the *next* agent, and it MUST let them continue without the original chat.

- `status`: always `recorded`. A checkpoint is never edited after it is committed; newer checkpoints replace it.
- `task` (required): the task id.
- `git` (required): `{branch?, base?, head, dirty, changed_paths?}`. `head` and `dirty` are required, so a checkpoint without a Git reference is invalid.
  - `base`: merge-base with the default branch.
  - `dirty`: whether the working tree had uncommitted changes, including untracked files, **outside `.alethic/`**. Writing Alethic records never makes the code state dirty.
  - `changed_paths`: paths changed since `base`, including uncommitted changes when `dirty: true`.
- `done`: what is finished.
- `failed_approaches`: `[{approach, why_failed, evidence?}]`. This is the field most often missing from handoffs, and one of the most valuable.
- `open_questions`: unknowns the next agent must not guess at.
- `next_safe_action` (required): one concrete step that is safe to take without further context. An agent that must stop without knowing the next step still checkpoints: `alethic checkpoint create` falls back to the task's `next_action`, then to `Not determined: review open_questions and failed_approaches before acting.`
- `receipts`: verification receipts covering this state.

<!-- alethic:schema=checkpoint -->
```yaml
id: cp-session-reset-20260913t201500z
kind: checkpoint
schema_version: 1
summary: Session invalidation half done; token-version approach in progress, refresh-path test still red.
status: recorded
confidence: agent-reported
created_by:
  agent: codex
created_at: "2026-09-13T20:15:00Z"
valid_at: "9c1e4b7"
task: task-session-reset-invalidation
scope:
  paths:
    - apps/api/auth/**
git:
  branch: feat/session-reset
  base: "5d2a9f0"
  head: "9c1e4b7"
  dirty: true
  changed_paths:
    - apps/api/auth/password-reset.ts
    - apps/api/auth/session.ts
    - apps/api/auth/session.test.ts
    - apps/api/db/migrations/0042_token_version.sql
done:
  - Added users.token_version column (migration 0042).
  - Password reset increments token_version.
failed_approaches:
  - approach: Delete all session rows on reset.
    why_failed: Refresh tokens are cached in Redis for 15 minutes, so deleted sessions kept working.
    evidence:
      receipts:
        - rcpt-auth-tests-20260913t200200z
open_questions:
  - Should API keys issued before the reset also be revoked?
next_safe_action: Make refresh-token validation in apps/api/auth/refresh.ts compare token_version, then rerun pnpm test auth.
receipts:
  - rcpt-auth-tests-20260913t200200z
links:
  - kn-refresh-tokens-cached-in-redis
```

### 6.5 Receipt

The recorded result of a test, build, lint, or other check, tied to the code state it ran on. A receipt is either **observed**, when `alethic receipt run` executed the command and captured the code state around it, or **imported**, when `alethic receipt add` records a result someone reports.

- `status`: always `recorded`. Receipts are append-only.
- `command` (required), `exit_code` (required), `result` (required): `pass` (exit code MUST be 0) | `fail` (exit code MUST NOT be 0) | `error` (the check could not run properly).
- `ran_at` (required), `duration_ms`.
- `git` (required): `{branch?, head, dirty}` when the check started (observed) or was reported (imported). `dirty` means the same as in a checkpoint: uncommitted changes outside `.alethic/`.
- `output_tail`: at most 4,000 characters from the end of the output, redacted (§13) before writing.
- `provenance`: `{source: local | ci-env | github-attestation, capture?: observed | imported, run_url?, attestation?}`. A receipt without `capture` counts as imported. An imported receipt MUST NOT be presented as observed.
- `execution` (observed): `{argv, cwd, started_at, finished_at, signal?}`. `cwd` is relative to the repository root. Environment variables are passed to the command but never recorded.
- `state` (observed): `{coverage, file_limit, before, after, changed_during_run}`. `before` and `after` are `{head, dirty, digest, files}` snapshots taken just before and just after the command. `digest` summarizes the content of every tracked and untracked (not ignored) file outside `.alethic/` and forbidden paths (`coverage: workspace`), or only files matching `scope.paths` when given (`coverage: scope`). When more files match than `limits.max_receipt_files`, only the first ones in path order are digested (`coverage: partial`). `changed_during_run` is true when the digest or HEAD differs between the two snapshots.

Observed execution is not cryptographic CI provenance: an observed receipt made in CI is still at most `ci-reported` (§8).

**Does a receipt apply to the code now?** Tools decide at read time, and never by commit alone:

- **Observed:** compare the `after` digest with a digest of the same files now. Equal means the files are unchanged since it ran; different means they changed, even when HEAD did not move. With partial coverage only a change is certain. When files changed during the run, what it tested is unclear, whatever the digests say now.
- **Imported:** compare commits. That is sound only when neither the reported run nor the current tree had uncommitted changes; otherwise applicability is unknown.

Briefings and PR summaries say which case applies, whether the receipt was observed or reported, whether it ran on uncommitted changes, and when coverage was partial.

<!-- alethic:schema=receipt -->
```yaml
id: rcpt-auth-tests-20260913t200200z
kind: receipt
schema_version: 1
summary: Auth suite fails after deleting session rows; refresh token still accepted.
status: recorded
confidence: agent-reported
created_by:
  agent: codex
created_at: "2026-09-13T20:02:30Z"
valid_at: "9c1e4b7"
command: pnpm test auth
exit_code: 1
result: fail
ran_at: "2026-09-13T20:01:10Z"
duration_ms: 79400
git:
  branch: feat/session-reset
  head: "9c1e4b7"
  dirty: true
output_tail: |
  FAIL apps/api/auth/session.test.ts > refresh token rejected after reset
    expected 401, received 200
  Tests: 1 failed, 38 passed, 39 total
provenance:
  source: local
scope:
  paths:
    - apps/api/auth/**
```

## 7. Manifest

`.alethic/manifest.yaml` holds project-wide settings. Every section except `format_version` and `project` is optional, and the defaults are shown below.

<!-- alethic:schema=manifest -->
```yaml
format_version: 1
project:
  name: acme-api
defaults:
  budget: 2500              # approximate briefing size for resume (§14)
  lease_minutes: 240        # task ownership lease length (§12)
  default_branch: main
privacy:
  extra_secret_patterns:    # JavaScript regexes, added to the built-in set (§13)
    - "acme_live_[A-Za-z0-9]{24}"
  forbidden_globs:          # paths records must never cite or fingerprint
    - "**/*.env"
staleness:
  changed_lines_threshold: 20
limits:
  max_glob_matches: 2000
  max_fingerprints_per_record: 50
  max_receipt_files: 20000  # files digested before and after `receipt run` (§6.5)
trust:
  ci_provenance: none       # none | github-attestation (§8)
```

## 8. Provenance and trust levels

Every record carries exactly one `confidence`. From lowest to highest trust: `inferred` < `agent-reported` = `ci-reported` < `human-confirmed` < `ci-verified`.

| Level | Meaning | Who may assign it |
|---|---|---|
| `inferred` | Derived by reading code or history; nobody observed it directly. | Anyone. |
| `agent-reported` | An agent observed or did it in its own session. | Any agent. This is the default for agent writes. |
| `ci-reported` | A self-report made from a CI environment (`CI=true`, clean tree). It carries **the same weight as `agent-reported`**: any local process can set `CI=true`, so the label records where a claim was made, not that anyone checked it. | Tooling, automatically. Receipts also record `provenance.source: ci-env`. |
| `human-confirmed` | A person's confirmation was **recorded**: an `evidence.human` entry names them, says which agent recorded it (`recorded_by`), and is bound to a digest of the claim (`claim_digest`). The name is an attribution by whoever wrote the record, not an authenticated identity (`authentication: none`). | Only with a non-empty `evidence.human` entry (enforced by schema). Tools set it only when passed `--human <name>`, never over MCP. Anyone who can run the CLI or edit the files can pass any name. |
| `ci-verified` | Backed by CI provenance that can be checked cryptographically. | Only when `manifest.trust.ci_provenance` names a trusted source **and** the cited receipt's `provenance` verifies against it. |

### 8.1 Trust boundary

Alethic runs with the permissions of whoever invokes it. Any process that can write the working tree (an agent, a person, a script) can create or edit any record, choose any label, and name any person. The format's checks make labels **consistent and visible**, not unforgeable. Identity, evidence provenance, and current applicability are separate questions: `created_by` and `recorded_by` say who wrote something, `confidence` and `evidence` say where a claim comes from, and staleness (§9) says whether it still matches the code.

| Level | Establishes | Does not establish |
|---|---|---|
| `inferred` | Someone derived the claim from code or history. | That anyone observed it. |
| `agent-reported` | The named agent tool wrote the claim. | That it is true, or which session or model wrote it. |
| `ci-reported` | It was written in an environment reporting `CI=true`, on a clean tree. | That CI ran anything: any process can set `CI`. |
| `human-confirmed` | The writer recorded that the named person confirmed this exact claim text. | That the person exists, said so, or approved anything. The name is not authenticated. |
| `ci-verified` | Reserved for verifiable CI provenance. | Cannot be produced in format v1. |

What does protect a repository:

- **Review.** Git history shows which commit added or changed each record; review `.alethic/` diffs like code. If the repository requires signed commits, the signature authenticates the committer, not the person named in `evidence.human`.
- **Binding.** A confirmation's `claim_digest` is the SHA-256 of the record's claim fields, as canonical JSON with sorted keys: `summary`, `intent`, and `scope` for tasks; `summary`, `topic`, `chosen`, `rationale`, `alternatives`, `scope`, and `supersedes` for decisions; `summary`, `category`, `body`, and `scope` for knowledge; `summary`, `task`, `git`, `done`, `failed_approaches`, `open_questions`, and `next_safe_action` for checkpoints; `summary`, `command`, `exit_code`, `result`, `git`, and `output_tail` for receipts, together with `kind`. Status, confidence, evidence, timestamps, anchors, and ownership are not part of the claim.
- **Outdated confirmations are visible.** When the claim no longer matches the digest of the latest confirmation, briefings show *unverified: edited after <name> confirmed it*, `validate` warns (`confirmation-outdated`), ranking treats the record as `agent-reported`, and `verify` without `--human` does not restore the label. Update commands that change a confirmed claim downgrade it to `agent-reported` with a warning, keeping the confirmation history.
- **Older confirmations.** An `evidence.human` entry without `claim_digest` (written before digests existed, or by hand) cannot be tied to the current text, and briefings say so. The new fields are optional, so existing records stay valid; to bind a confirmation, re-confirm with `alethic verify <id> --human <name>`.

Authenticated approval is not part of format v1. If it is added, it will bind a verifiable reviewer identity (for example a signed attestation) to a `claim_digest`, use a distinct `authentication` value, and never be inferred from a `--human` name.

Rules:

1. Labels record provenance; they are not credentials. Tools MUST NOT grant `ci-verified` based on environment variables, file paths, agent names, or anything else a local process controls, and MUST NOT present `human-confirmed` as authenticated approval. Tools that sort, score, or filter by trust MUST NOT rank `ci-reported` above `agent-reported`.
2. In format v1, `validate` MUST reject `ci-verified` when `trust.ci_provenance` is `none` or absent. The attestation verifier for `github-attestation` is on the roadmap; until it ships, `ci-verified` cannot be produced.
3. No tool upgrades confidence on its own. Upgrades happen through an explicit action such as `alethic verify <id> --human <name>`, and that action is visible in the Git diff.
4. Briefings (§14) show a bound `human-confirmed` record as *confirmed by <name>, as recorded by <agent>; not authenticated*, and an unbound or outdated one with a ⚠ marker. Every lower level is shown as *unverified*.
5. When evidence commits disappear (squash merge, rebase, shallow clone), the record keeps its confidence, and validators report a warning, not an error (§9). Durable evidence such as PRs, issues, and receipts is preferred over branch-local commit ids.

## 9. Anchoring and staleness

A record describes code at a moment in time. When that code changes, the record may no longer apply.

**`valid_at`** is the commit the author considered the record true at. It exists for humans and as a hint. Commit ancestry is unreliable after squash merges, rebases, branch deletion, and shallow clones, so ancestry alone MUST NOT mark a record stale or broken.

Commit ids MAY be abbreviated. Tools MUST resolve them with Git before comparing them and MUST NOT compare ids as strings: `83fa2de` and its full 40-character id are the same commit.

**`anchor`** is the basis for staleness. When a record is written, tools capture Git blob ids for its `evidence.files` and for tracked files matched by `scope.paths` (subject to the limits in §10):

```yaml
anchor:
  commit: "<full sha of HEAD when written>"
  fingerprints:
    apps/api/auth/session.ts: "<blob id>"
  overflow:              # present only when more files matched than the limit
    count: 212
    digest: "<object id summarizing the remaining matched files>"
```

The derived status is computed at read time and never written into the record automatically:

| Derived status | Condition |
|---|---|
| `unchanged` | Every fingerprint that counts matches the current tree, and nothing was added under the record's direct scope. |
| `scope_changed` | The direct files are unchanged, but files matched only by a scope glob changed, were removed, or were added. The claim's own evidence did not change. |
| `uncertain` | Whether the record still applies cannot be established: it names files but nothing was fingerprinted, or a cited `evidence.files` path has no fingerprint. |
| `needs_reverification` | A direct file's content changed **by any amount**, a direct file was removed, or files were added to a scope that has no direct files. |
| `broken_evidence` | A cited `evidence.files` path no longer exists. |
| `diverged` | The anchor commit exists and is not an ancestor of `HEAD`, **and** direct content differs. The record describes code from another line of history that does not match this one. |
| `unanchored` | The record names no files, so there is nothing to compare. |

**Any change counts.** A one-line edit can reverse the condition a claim depends on, so no change to direct evidence is small enough to ignore. Differences are counted with a line diff that respects order, so reordering operations is a change. `staleness.changed_lines_threshold` only labels a change *small* or *large* to help order review; the label never makes a record `unchanged`. When the anchored version of a changed file is not in the repository (for example, it was never committed), the size is reported as *unknown* rather than guessed.

**Direct and context files.** A fingerprinted file is *direct* when it is listed in `evidence.files` or named exactly in `scope.paths`. Other fingerprinted files are *context*: they were matched only by a glob or a directory. When a record has any direct files, changes to context files, files added under a glob, and changes summarized in `overflow` give `scope_changed`, never `needs_reverification`, and the change is explained without implying that the evidence changed. Evidence files that overflowed the fingerprint limit are still direct. A record anchored only by globs has no direct files, so every matched file counts as direct for it.

An anchor commit that is missing, or not an ancestor, while the fingerprints still match is reported only as an informational note ("anchor commit unavailable"). This is why a record created on a feature branch stays `unchanged` after that branch is squash-merged and deleted.

`validate` warns about `needs_reverification`, `diverged`, and `uncertain` records that have an anchor (`uncertain-applicability`). Hand-written records without an anchor (§18) are not warned about, but briefings and the dashboard still mark them. Briefings mark `needs_reverification`, `diverged`, and `broken_evidence` as *may be stale* (noting a *small change* when it is one), `uncertain` as *applicability unknown*, and `scope_changed` with an informational note.

A record is re-anchored only by an explicit action (`alethic verify`), and that action shows up as a diff.

## 10. Path safety

Every path in `scope.paths`, `evidence.files`, `git.changed_paths`, `anchor.fingerprints`, and `privacy.forbidden_globs`:

- MUST be repository-relative and use POSIX `/` separators;
- MUST NOT be absolute (`/etc/passwd`), start with `~`, contain a drive letter (`C:`), backslashes, empty segments (`a//b`), `.` or `..` segments, or NUL bytes;
- MUST NOT resolve, after following symlinks, to a location outside the repository root;
- MUST NOT match `privacy.forbidden_globs`.

Globs use `*`, `**`, `?`, `[...]`, and `{a,b}`. They are expanded **only against tracked files** (`git ls-files`), never by walking the filesystem, so ignored directories such as `node_modules` are never visited. Expansion stops after `limits.max_glob_matches` files, with a warning.

Each record fingerprints at most `limits.max_fingerprints_per_record` files: cited `evidence.files` first, then scope matches, each group in sorted path order, so the result is deterministic. Any remaining matched files are summarized in `anchor.overflow`. Write commands accept `--max-fingerprints N` to override the limit for a single record.

## 11. Merge behavior and conflicts

Alethic relies on Git to merge records and adds checks for the conflicts Git cannot see.

| Situation | What happens |
|---|---|
| Two branches add different records | Merges cleanly, because each record is its own file. |
| Two branches edit the same task or decision | An ordinary Git conflict, resolved by a human in review. |
| Two branches create the same id | A Git add/add conflict. Timestamped ids make this unlikely for checkpoints and receipts. |
| Checkpoints and receipts | Append-only. `validate` rejects a committed checkpoint or receipt whose content differs from the version first committed. |
| Two `accepted` decisions with the same `topic` and overlapping scope, neither superseding the other | A **contradiction**, reported by `validate` (warning) and `doctor`. |
| Two `active` tasks with unexpired leases held by different writers over overlapping paths: different agents, or two recorded sessions of the same agent | An **overlapping claim**, reported by `doctor` with both writers and sessions. |
| Two sessions edit the same task, decision, or knowledge record on one working tree | The second write is refused because the file changed after it was read (§12); nothing is lost. |
| A checkpoint written by another writer while the task's current owner held its lease, usually from merged branches | A **competing claim**, reported by `doctor` with both attributions (§12). |
| A checkpoint whose task is `done` or `abandoned` | Reported by `doctor` as orphaned work. |

Resolving a contradiction means writing a new decision that `supersedes` the loser, or setting the loser to `status: superseded`.

## 12. Task ownership leases

An `active` task has an `owner` with a lease, which signals to other agents that someone is working on it.

- `alethic task start` and `alethic task claim` set `lease_expires_at = now + defaults.lease_minutes`.
- Claiming a task whose lease is held by another agent and has not expired fails without `--force`. Renewing your own lease always succeeds.
- An `active` task whose lease has expired is **invalid**: `validate` rejects it. An agent that stops work MUST either hand off (write a checkpoint and set `status: paused`) or renew. This keeps abandoned claims from blocking other agents.
- Leases are advisory coordination, not locks. Git remains the source of truth.
- **Sessions.** `owner.session` and `created_by.session` record which run of an agent tool wrote something (`ALETHIC_SESSION`; each `alethic mcp` connection gets its own id when the variable is unset). Two sessions of the same tool are different writers: a lease that names a session is held against every other session, including a caller that names no session, and overlapping claims by two sessions of one tool are reported. A lease without a session can be renewed by any session of its agent, because nothing recorded tells them apart. `created_by.model` records the model only when the caller states it (`ALETHIC_MODEL`).
- **Scope of a lease.** A lease describes the repository state an agent can see. It is not a global lock: two clones or branches can each hold a lease on the same task until their records meet in a merge.
- **Competing writes on one working tree.** Replacing a task, decision, or knowledge record takes a short lock and checks that the file still has the content the command read. If another writer changed it in between, nothing is written and the command says so; running it again applies the change to the current version. Creating a record fails if the file appeared in the meantime, so a checkpoint or receipt is never silently replaced.
- **Competing claims after a merge.** When branches that claimed the same task are merged, Git leaves one `owner` (a conflict a person resolves). `doctor` then reports checkpoints written by a different writer while the surviving owner's lease was in force (`competing-claim`), naming both writers and sessions, so the team can decide which session continues and have it `task claim --force`.

### 12.1 Concurrent work on other branches

Leases stop at the edge of one checkout, but parallel agents usually work on separate branches, often in separate worktrees of one clone. Their changes can each pass alone and fail together when one changes an interface another relies on. So `resume` also reports work on other lines of history that touches the task, read without checking anything out and without network access.

- **Sources.** Other worktrees of this clone, read from their directories, so records written there but not yet committed are included and labeled *uncommitted*; and local branches not merged into HEAD, read from Git objects. A branch checked out in another worktree is read from that worktree; a branch whose worktree directory is gone is read from the branch. The current worktree and branch are never sources. Remote-tracking branches are not read. At most 25 sources are examined per command: other worktrees first, then branches by most recent commit.
- **Since the split.** For each source, `base` is the merge base of HEAD and the source's tip. Only what changed after `base` and still differs from HEAD counts: record files added or changed since `base`, and code paths (outside `.alethic/`) changed since `base`, including uncommitted and untracked files in a worktree, each left out when its content is the same as HEAD's. Records both lines inherited are ignored, and so is a branch whose work already arrived here by a squash merge or cherry-pick, which ancestry alone cannot tell; a file both sides changed differently is still reported. A source with no merge base (an orphan branch, or history missing in a shallow clone) is skipped and reported by `status --all-branches`.
- **Checked with this checkout's rules.** Records from a source pass the same checks as local ones (§14, "Checked before compiled"), using **this** checkout's manifest privacy settings, never the source's, so a branch cannot weaken what may be shown here. Withheld records are counted, never shown. Changed paths that match this checkout's `privacy.forbidden_globs` are never listed.
- **Relevance.** A source is reported in a briefing when it changed files inside the task's `scope.paths`, or has tasks, decisions, or knowledge whose paths overlap that scope (matched both ways, so files that exist only on the other branch count), or has a record about the task itself (the task, or a checkpoint for it). Task status and leases are shown as information; neither is required.
- **Not a claim about this code.** Records from another source are attributed claims about unmerged work. They carry trust markers (§8) but no freshness markers, which are judged against this checkout (§9). Nothing from a source changes what this checkout's records mean.
- **Derived, not stored.** No record field describes other branches; everything here is computed when read, from Git and the worktrees' files.

## 13. Privacy boundary

Committed Alethic state is **shared, reviewable, and permanent**: once pushed, assume it is public to everyone with repository access, forever.

MUST NOT appear in any record:

- chat transcripts, prompts, model reasoning, or excerpts of them;
- credentials of any kind: API keys, tokens, passwords, private keys, connection strings with credentials, cookies;
- customer or personal data: emails, names of end users, addresses, payment data, production records;
- model- or vendor-private memory content;
- content from paths matching `privacy.forbidden_globs`.

Enforcement:

- Write commands scan every string field and refuse to write anything that matches a secret pattern. `validate` runs the same scan and rejects matching records.
- The built-in patterns cover PEM private-key blocks; AWS access key ids; Google API keys; GitHub, GitLab, Slack, Stripe, OpenAI, and Anthropic token formats; JWTs; URLs with embedded credentials; and assignments shaped like `password|passwd|secret|token|api[_-]?key` followed by `:` or `=` and a non-placeholder value. Projects add their own patterns with `privacy.extra_secret_patterns`.
- `receipt.output_tail` is redacted before writing, with matches replaced by `[REDACTED]`.
- `alethic receipt run` passes the environment to the command but never records it. Its argv is scanned like any other field, so a credential on the command line blocks the receipt instead of being stored.
- Scanning is a safety net, not a guarantee. Review `.alethic/` diffs like any other code.

`.alethic/local/` is gitignored for per-machine scratch. Tools never read it into shared outputs.

## 14. Context briefings

`alethic resume` compiles a briefing for the next agent from records and the current Git state:

1. **Goal**
2. **Current repository state**: branch, HEAD, dirty, and changes since base
   - **Integrity warnings**, only when there are any (see below)
   - **Concurrent work on other branches**, only when there is any (§12.1)
3. **Relevant architecture and decisions**
4. **Files changed or likely relevant**
5. **Verified behavior and checks run**
6. **Failed approaches**
7. **Open questions**
8. **Next safe action**

Rules:

- **Deterministic.** The same records and Git state (including other worktrees' files, §12.1) always produce byte-identical output. Retrieval uses task ids, explicit links, path overlap, topic, trust level, recency, and Git state, never embeddings.
- **Traceable.** Every bullet cites its source: a record id (`[dec-auth-session-rotation]`), a record on another branch or worktree (`[dec-auth-refresh-shape on feat/token-refresh]`, readable with `alethic show <id> --ref <branch or worktree>`), a commit (`(commit 83fa2de)`), or a receipt.
- **Honest.** Claims that are not `human-confirmed` or `ci-verified` are marked *unverified*. Records whose evidence changed are marked *may be stale*, records whose applicability cannot be established are marked *applicability unknown*, and changes only around a record's evidence are noted as such (§9).
- **Budgeted, approximately.** `--budget` is an **approximate** size target, estimated as `ceil(characters / 4)` tokens. Real tokenizer counts vary by model, so the budget is not a guarantee. Goal, repository state, and next safe action are always included. When space runs out, lower-priority items collapse to one-line summaries, then to "N more: ids…" pointers. A pointer line cites at most five records and counts the rest ("and 12 others"), so a large ledger cannot make it grow without limit. Goal, repository state, integrity warnings, concurrent work, and next safe action are never shortened; when they alone exceed the budget, the briefing is still produced and the overflow is reported, attributed to mandatory content and pointer lines. Every collapsed record remains retrievable (`alethic show <id>`), and the JSON form lists every item with its level and inclusion reasons.
- The `--target` agent changes only framing hints, such as which instruction file or MCP tools exist, never the content.
- **Checked before compiled.** Briefings, PR summaries, record views, and MCP record resources use the same record assessment as `validate` (§16). A record with a schema violation, an id or kind mismatch, a duplicate id, secret-like content, a forbidden path, or an untrusted trust label (such as a hand-written `ci-verified`) is **withheld**: none of its content is emitted, and it cannot be selected as the task. Other findings, such as an expired lease or a missing commit, leave a record usable.
- **Integrity warnings.** When anything is withheld, when a file under `.alethic/` cannot be loaded, when a relevant record refers to a record that is missing or withheld, or when two accepted decisions that touch the task contradict each other (§11), the briefing says so in a section of its own, always in full. Withheld records are named only by file, id, and finding code, so a secret is never echoed. Each kind of warning lists at most five items, then a count. Contradicting decisions are also marked *disputed* where they appear.
- **Concurrent work.** Work on other branches and worktrees that touches the task (§12.1) is shown in a section of its own, always in full but capped: at most three sources, most relevant first (live worktrees, then the most recently committed), each with its changed files in scope, its latest commit date, and whether anything is uncommitted; at most two record lines in the whole section; and bounded line lengths that never cut a citation or trust marker. The rest is counted and left to `alethic status --all-branches`. `--no-concurrent` leaves the section out.
- **Attributed, not authoritative.** Record text is evidence written by the agent or person named in it. It never overrides repository or user instructions, and the briefing says so.

## 15. Agent compatibility

The format is agent-neutral. Integrations are thin:

- **Instruction files.** `alethic render` maintains a marked block (`<!-- alethic:begin -->` … `<!-- alethic:end -->`) in `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. The block tells the agent to run `alethic resume` before non-trivial work, write checkpoints only at meaningful boundaries, run checks through `alethic receipt run` (or record ones that already ran with `alethic receipt add`), never store private content (§13), and run `alethic validate` before closing work. Content outside the block is never touched. Agents do not share one instruction file by default: Codex reads `AGENTS.md`, Claude Code reads `CLAUDE.md`, and Gemini CLI reads `GEMINI.md` unless configured otherwise. A `CLAUDE.md` or `GEMINI.md` that imports `@AGENTS.md` can share the `AGENTS.md` block, and `render` detects that instead of writing a second copy.
- **MCP.** `alethic mcp` exposes the same operations as MCP tools and resources for agents that support MCP. Tools run the same command code as the CLI, including schema validation, path safety, and the secret scan. No MCP tool can mark a record `human-confirmed`: human confirmation goes through the CLI with `--human`.
- **CLI.** Every agent that can run shell commands can use the CLI directly. Identity comes from `--agent` or `ALETHIC_AGENT`.

Per-agent setup (exact config files and commands) lives in `docs/adapters/`, where it is checked against each vendor's current documentation.

## 16. Validation summary

`alethic validate` exits 0 when state is valid, 1 on errors, and 2 on usage or environment problems. It MUST report errors for:

- schema violations, mapped to `file: field` with a fix hint;
- a file name that does not match its id, a record in the wrong directory, or duplicate ids;
- dangling references in `links`, `task`, `receipts`, `evidence.receipts`, or `supersedes`;
- `evidence.files` that do not exist in the working tree;
- evidence commits that do not exist (reported as a warning in shallow clones and after history rewrites, and as an error with `--strict`);
- secret-like content (§13);
- unsafe paths (§10);
- `active` tasks with expired leases (§12);
- checkpoints without `git.head` (enforced by schema);
- `ci-verified` confidence without trusted provenance (§8);
- changes to committed checkpoints or receipts (§11);
- invalid regexes in `privacy.extra_secret_patterns`.

It reports warnings for derived staleness (§9) and contradictory decisions (§11).

## 17. Walkthroughs

### 17.1 Fresh task

```console
$ alethic init
Created .alethic/ (manifest, tasks, decisions, knowledge, checkpoints, receipts, local/)

$ ALETHIC_AGENT=codex alethic task start "Invalidate sessions after password reset" \
    --paths 'apps/api/auth/**' --branch feat/session-reset
Created .alethic/tasks/task-invalidate-sessions-after-password-reset.yaml (active, lease until 22:02Z)

$ git add .alethic && git commit -m "alethic: start session reset task"
```

Codex works and runs the auth tests, which fail. It records the result without Alethic running anything:

```console
$ pnpm test auth > /tmp/auth.log; echo $?
1
$ alethic receipt add --command "pnpm test auth" --exit-code 1 --output-file /tmp/auth.log
Created .alethic/receipts/rcpt-pnpm-test-auth-20260913t200200z.yaml (fail, agent-reported)
```

### 17.2 Agent handoff

Codex has to stop. It writes a checkpoint at this boundary:

```console
$ alethic checkpoint create \
    --done "Added users.token_version (migration 0042)" \
    --failed "Delete all session rows on reset::Refresh tokens are cached in Redis for 15 minutes" \
    --question "Should API keys issued before the reset also be revoked?" \
    --next "Make refresh-token validation compare token_version, then rerun pnpm test auth"
Created .alethic/checkpoints/cp-invalidate-sessions-after-password-reset-20260913t201500z.yaml
  git: feat/session-reset @ 9c1e4b7 (dirty), 4 changed paths, 1 receipt attached

$ alethic task update task-invalidate-sessions-after-password-reset --status paused
$ git add -A && git commit -m "wip: token version; alethic checkpoint" && git push
```

Claude Code picks the work up in a fresh session with no chat history:

```console
$ git pull && ALETHIC_AGENT=claude-code alethic task claim task-invalidate-sessions-after-password-reset
Claimed (lease until 01:30Z)

$ alethic resume --target claude-code --budget 2500
## Goal
After a password reset, every session and refresh token issued before it must stop working. [task-invalidate-sessions-after-password-reset] ⚠ unverified
## Failed approaches
- Deleting all session rows on reset: refresh tokens are cached in Redis for 15 minutes. [cp-…-20260913t201500z] (receipt rcpt-pnpm-test-auth-20260913t200200z)
## Next safe action
Make refresh-token validation compare token_version, then rerun pnpm test auth. [cp-…-20260913t201500z]
...
```

Claude does not repeat the failed approach. It records a decision, and the maintainer confirms it in PR review with `alethic verify dec-auth-session-rotation --human maintainer`.

### 17.3 Stale-memory detection

Weeks later, someone rewrites `apps/api/auth/refresh.ts` to use opaque tokens stored in Postgres, and the Redis cache goes away. Neither the decision nor the knowledge record is edited. An agent on a new task touching `apps/api/auth/**` runs:

```console
$ alethic resume --budget 1000
## Relevant architecture and decisions
- Rotate sessions on reset via per-user token_version. [dec-auth-session-rotation] ⚠ may be stale: apps/api/auth/refresh.ts changed 184 lines since anchor
- Refresh tokens cached in Redis for 15 minutes. [kn-refresh-tokens-cached-in-redis] ⚠ may be stale
...

$ alethic doctor
warning  kn-refresh-tokens-cached-in-redis  needs_reverification (apps/api/auth/refresh.ts: +120/-64)
         fix: confirm the fact still holds, then `alethic verify kn-refresh-tokens-cached-in-redis`,
              or mark it deprecated: `alethic knowledge update kn-refresh-tokens-cached-in-redis --status deprecated`
```

The agent is warned before it builds on a fact that no longer holds.

## 18. Creating a checkpoint by hand

You do not need the CLI to write a valid checkpoint.

1. Collect the Git state:
   ```console
   git rev-parse --abbrev-ref HEAD                    # branch
   git merge-base main HEAD | cut -c1-7               # base
   git rev-parse --short HEAD                         # head
   git status --porcelain | head -1                   # any output means dirty: true
   git diff --name-only $(git merge-base main HEAD)   # changed_paths (includes uncommitted edits)
   ```
2. Create `.alethic/checkpoints/cp-<task-slug>-<yyyymmdd>t<hhmmss>z.yaml`. The `id` MUST match the file name.
3. Fill in the required fields: `id`, `kind: checkpoint`, `schema_version: 1`, `summary`, `status: recorded`, `confidence` (use `agent-reported`, or `inferred` when reconstructing from history), `created_by.agent` (`human` if you are writing it yourself), `created_at` (UTC, ending in `Z`), `task`, `git.head`, `git.dirty`, and `next_safe_action`. Quote shas.
4. Add whatever else helps the next person: `done`, `failed_approaches`, `open_questions`, `receipts`. Leave out anything private (§13).
5. Validate with `alethic validate`, or without Alethic by converting the YAML to JSON and checking it against `schemas/checkpoint.schema.json` with any JSON Schema 2020-12 validator (register `schemas/common.schema.json` too).
6. Commit it.

Use the example in §6.4 as a template. For contrast, this is **invalid**: it has no `git.head`, and its changed path is absolute.

<!-- alethic:schema=checkpoint expect=invalid -->
```yaml
id: cp-bad-example-20260913t000000z
kind: checkpoint
schema_version: 1
summary: Missing git.head and uses an absolute path.
status: recorded
confidence: agent-reported
created_by:
  agent: human
created_at: "2026-09-13T00:00:00Z"
task: task-session-reset-invalidation
git:
  branch: main
  dirty: false
  changed_paths:
    - /etc/passwd
next_safe_action: Nothing.
```

And this decision is invalid because it claims `human-confirmed` without naming a human:

<!-- alethic:schema=decision expect=invalid -->
```yaml
id: dec-unbacked-claim
kind: decision
schema_version: 1
summary: Claims human confirmation with no human evidence.
status: accepted
confidence: human-confirmed
topic: auth.session-invalidation
chosen: Anything.
rationale: None given.
created_by:
  agent: codex
created_at: "2026-09-13T00:00:00Z"
```

## Appendix A: machine-checked examples

YAML examples in this document and in `docs/adapters/*.md` are validated by the test suite (`test/spec/spec-examples.test.ts`). The convention is strict so that any tool extracts the same examples:

- An example is checked **only** if the line directly before its opening fence is exactly `<!-- alethic:schema=<name> -->` or `<!-- alethic:schema=<name> expect=invalid -->`, where `<name>` is one of `manifest`, `task`, `decision`, `knowledge`, `checkpoint`, `receipt`.
- The marker MUST start at column 0, with exactly one space inside each comment delimiter.
- The next line MUST be exactly three backticks followed by `yaml`, with no blank line between marker and fence. The block ends at the next line consisting of exactly three backticks.
- Untagged YAML blocks are illustrative and ignored.
- Markers inside other code fences are ignored.
- Any comment line starting with `<!--` and containing `alethic:schema` that does not match the exact form, a marker not followed by a yaml fence, or an unknown schema name fails the test.
- A block marked `expect=invalid` MUST fail schema validation. All other tagged blocks MUST pass.
