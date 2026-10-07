# How Alethic compares

Alethic sits between things teams already use. It replaces none of them. This page describes categories of tools, not specific products, because features change quickly.

| | Survives a switch to another agent | Reviewed in pull requests | Tied to a code version | Flags when code changes | Structured for handoff | Sees parallel work on other branches |
|---|---|---|---|---|---|---|
| Chat transcripts and session resume | No | No | No | No | No | No |
| An agent's private memory | No | Usually not | No | No | No | No |
| Shared memory servers (via MCP or plugins) | Yes | Usually not | Rarely | Rarely | Partly | Partly, not by branch |
| Instruction files (`AGENTS.md`, …) | Partly | Yes | No | No | No | No |
| Architecture decision records | Yes | Yes | Loosely | No | No | No |
| Issue trackers and PR descriptions | Yes | Partly | Loosely | No | Partly | Once a PR is open |
| **Alethic** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes, locally** |

## Chat transcripts and session resume

A transcript holds everything an agent saw and said, which is the problem: it is long, specific to one tool, and full of dead ends, tool output, and sometimes secrets or customer data. Resuming a session works only with the same tool, and usually only for the same person.

Alethic stores the conclusions instead: what failed and why, what was decided, what ran, and what to do next. It never stores the transcript, and committing one is outside its privacy boundary (spec §13).

## An agent's private memory

Some agents keep their own memory across sessions. That memory helps that agent, for that user. Other agents cannot read it, reviewers never see it, and it does not know which commit a memory was true at.

Alethic is shared, and memory that stays private to one agent belongs in `.alethic/local/`, which is never committed and never read by `resume`.

## Shared memory servers

A growing category of tools gives several agents one memory: a local service or plugin, reached over MCP or agent-specific hooks, that captures observations and session summaries and retrieves them by search. Some add explicit handoff notes with open questions and next steps. These do survive a switch between agents, which private memory does not.

The differences are where the memory lives and what it is checked against. It is usually kept in the service's own store rather than in the repository, so it is not reviewed in pull requests and does not branch or merge with the code. Retrieval is by relevance, and the memory is rarely tied to the code version it described, so nothing flags a memory whose code has since changed.

Alethic is a smaller, stricter thing: a few record types, committed with the code, validated before use, anchored to content fingerprints, and compiled deterministically. Because its records live on branches, it can also tell an agent what other worktrees and branches of the same clone changed or recorded in its task's scope since they split (spec §12.1), which a store outside the repository cannot place on a line of history. Search is local and opt-in: BM25 by default, and optionally a local embedding model ([search](search.md)), but vectors are a disposable cache and results are labeled with freshness and trust rather than trusted for being similar. It does not summarize. A team can use both: a memory server for recall across a person's sessions, and Alethic for the task state that should travel with the branch.

## Instruction files

See [Why not just AGENTS.md?](why-not-agents-md.md). In short: instruction files are for stable conventions, and Alethic is for changing task state. Alethic adds a short block to the instruction file so agents know to use it.

## Architecture decision records (ADRs)

ADRs record significant, long-lived architectural choices, written and reviewed by people. Alethic decisions are smaller and more frequent: a choice made during one task, with rejected alternatives, often written by an agent and marked unverified until a person confirms it. They are anchored to the files they concern and flagged when those files change.

They work together. An Alethic decision can cite an ADR in `evidence.files`, and an accepted decision worth keeping long-term can be written up as an ADR.

## Issue trackers and pull request descriptions

The tracker says what should be done and who is assigned. Alethic records the state of the work in progress: the current branch and commit, checks that ran, approaches already ruled out, and the next safe step. That state changes too often, and is too tied to code, to maintain by hand in a ticket.

Tasks can cite issues and pull requests (`--issue`, `--pr`), and `alethic render pr-summary` turns the records into a PR description.

## What Alethic is not

- **Not an orchestrator.** It does not start, schedule, or coordinate agents. Leases are advisory.
- **Not a test runner or CI.** Receipts record checks that already ran. `ci-verified` is reserved for verifiable CI provenance, which is not implemented yet, so nothing can claim it.
- **Not a truth oracle.** It does not decide whether a claim is correct. It records who made the claim, what supports it, and whether the code it describes has changed since.
- **Not a hosted service.** Everything lives in your repository.
