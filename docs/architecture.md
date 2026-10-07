# Architecture

Alethic is a CLI over a directory of YAML files. Every other surface (the MCP server, instruction blocks, the GitHub Action) goes through the same commands. There is no service, database, or network access.

```mermaid
flowchart LR
  subgraph Callers
    codex[Codex]
    claude[Claude Code]
    gemini[Gemini CLI]
    people[People and CI]
  end

  codex -->|shell| cli[alethic CLI]
  claude -->|shell| cli
  gemini -->|shell| cli
  people -->|shell, GitHub Action| cli
  claude -.->|MCP stdio| mcp[alethic mcp]
  codex -.->|MCP stdio| mcp
  gemini -.->|MCP stdio| mcp
  mcp -->|same commands, in-process| cli

  cli --> write["Write path<br/>identity, path safety, references,<br/>anchor capture, secret scan, schema"]
  write --> files[(".alethic/*.yaml<br/>one file per record")]
  files <-->|commit, merge, review| git[(Git)]

  files --> read["Read path<br/>load, validate, staleness, conflicts"]
  git --> read
  read --> resume["resume<br/>collect, assess, score, budget, cite"]
  read --> checks["validate, status, doctor"]
  read --> render["render<br/>instruction blocks, PR summary"]
```

## Write path

Every command that writes a record (`task`, `decision`, `knowledge`, `receipt`, `checkpoint`, `verify`, `doctor --fix`) does the same steps, in `src/core/write.ts`:

1. **Identity.** `--agent` or `ALETHIC_AGENT`, required.
2. **Path safety.** Paths must be repository-relative. Absolute paths, `..`, symlink escapes, and forbidden globs are refused. Globs expand only against `git ls-files`, and expansion is capped (`src/core/paths.ts`).
3. **References.** Linked records must exist and be the right kind.
4. **Anchor.** Git blob ids of the evidence files, then of scope matches, are captured up to a limit; the rest are summarized in an overflow digest (`src/core/anchor.ts`).
5. **Secret scan, then schema validation.** If either fails, nothing is written, and secret values are never echoed.
6. **Atomic write.** Written to a temporary file, then renamed.

Checkpoints and receipts are append-only. `validate` compares them with the version first committed.

## Read path

- **Assessment** (`src/validate/assess.ts`) is the shared read path. It loads records and runs the checks that need neither Git history nor the filesystem: schema, identity, references, secrets, trust labels, and forbidden paths. Records with excluding findings are withheld from the usable index. `resume`, `render pr-summary`, `checkpoint list/show`, MCP record resources, and the dashboard read only that index, so a hand-edited record cannot reach an agent without passing the same checks as `validate`.
- **Validation** (`src/validate/`) is the assessment plus leases, symlink containment, commits, append-only history, staleness, and contradictions. Each finding has a code, location, and hint.
- **Staleness** (`src/trust/staleness.ts`) compares anchored fingerprints with the working tree when a record is read. The status is derived and never written: `unchanged`, `scope_changed`, `uncertain`, `needs_reverification`, `diverged`, `broken_evidence`, or `unanchored`. Any change to direct evidence needs re-verification; an order-respecting line diff sizes it only to order review. Commit ancestry is only a hint, which is why records survive squash merges and shallow clones. Briefings, `validate`, and the dashboard all read these statuses from the same function.
- **Conflicts** (`src/trust/conflicts.ts`) finds contradictory decisions, overlapping claims, orphaned checkpoints, and superseded decisions that are still accepted. It uses the same scope-overlap rules as `resume`.

## Briefing compiler (`resume`)

```mermaid
flowchart LR
  task[Task] --> collect
  collect["collect<br/>links both ways, cited receipts,<br/>receipts on this line, path overlap"] --> assess["assess<br/>staleness per record,<br/>code changed since each receipt"]
  assess --> score["score<br/>how found, trust, accepted,<br/>anchor on this line"]
  score --> allocate["allocate<br/>required sections in full,<br/>then leaders per section,<br/>then detail by priority"]
  allocate --> cite["render<br/>every bullet cites its source,<br/>⚠ for unverified or stale"]
```

The compiler is deterministic. It uses no embeddings and no model calls (the separate, opt-in `search` command may; see [search](search.md)), and identical records and Git state produce byte-identical output. Git queries about commits are memoized for the run (`createGitLookups`), because a large ledger names the same few commits many times. Collapsed "N more" lines cite at most five records, so their size does not grow with the ledger, and `resume --format json` is the inspectable result: every item with its level, inclusion reasons, score, and freshness, plus a token report and the records skipped on purpose. `alethic show <id>` reads any collapsed record. The budget is approximate (characters / 4). Failed approaches and open questions are kept before decisions and file lists when space is short, because they exist nowhere else. The target agent changes only the header and footer.

## Integrations

- **Instruction blocks** (`src/adapters/blocks.ts`): a short managed block between markers in `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`. Its job is the trigger: start from `alethic resume`.
- **MCP** (`src/mcp/`): a dependency-free JSON-RPC server over stdio. Each tool call runs the matching CLI command in-process, one call at a time, so validation and the secret scan cannot drift from the CLI. The official MCP SDK is used only in tests.
- **GitHub Action** (`action.yml`): runs `alethic validate` in CI.
- **Dashboard** (`src/dashboard/`): `ledger.ts` builds a read model (sessions, record nodes, explicit and inferred edges, timeline, health) from the shared assessment, freshness, receipt, conflict, and validation code; `server.ts` serves it read-only on loopback; `page.ts` and `client.ts` are a single self-contained page with no dependencies. See [dashboard.md](dashboard.md).

## Source layout

| Directory | Contents |
|---|---|
| `schemas/` | JSON Schemas for every record kind and the manifest (the format's source of truth, with `docs/spec.md`) |
| `src/core/` | Records, ids, clock, YAML format, paths, manifest, anchors, and the write path |
| `src/git/` | Git via `execFile`, never a shell |
| `src/validate/` | Schema errors, references, secrets, leases, and the validator |
| `src/trust/` | Confidence ranks, staleness, and conflicts |
| `src/compile/` | `resume` collection, scoring, budgeting, the briefing, and PR summaries |
| `src/adapters/` | Managed instruction blocks |
| `src/mcp/` | MCP server, tool definitions, and stdio framing |
| `src/commands/` | One module per command |
| `test/` | Unit, spec-example, and end-to-end tests, fixtures, golden briefings, and the demo test |
