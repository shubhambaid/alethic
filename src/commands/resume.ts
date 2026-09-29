import {
  buildBriefing,
  type CheckpointRelation,
  type ConcurrentNote,
  type IntegrityNotes,
  TARGETS,
  type Target,
} from "../compile/briefing.js";
import { type Collected, collect, type GitState } from "../compile/collect.js";
import { type AssessedCandidate, rankCandidates, type ScoredCandidate } from "../compile/score.js";
import { now } from "../core/clock.js";
import { UsageError } from "../core/errors.js";
import { asObject, asString } from "../core/json.js";
import type { Manifest } from "../core/manifest.js";
import { checkRepoPath, scopeMatcher } from "../core/paths.js";
import type { LoadedRecord } from "../core/store.js";
import { parseInteger } from "../core/write.js";
import {
  changedPathsSince,
  codeChangedBetween,
  commitsSince,
  createGitLookups,
  currentBranch,
  headCommit,
  isDirty,
  mergeBase,
  resolveBranchRef,
  resolveCommit,
  shortSha,
} from "../git/git.js";
import {
  gatherConcurrentWork,
  type RelevantWork,
  relevantConcurrentWork,
} from "../trust/concurrent.js";
import { createOverlapCheck, findContradictionPairs } from "../trust/conflicts.js";
import { assessReceipt, createReceiptContext } from "../trust/receipts.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import {
  assessLedger,
  type LedgerAssessment,
  requireManifest,
  requireUsable,
} from "../validate/assess.js";
import { collectReferences } from "../validate/references.js";
import { type Io, requireInitialized } from "./context.js";

export interface ResumeOptions {
  task?: string;
  target?: string;
  budget?: string;
  format?: string;
  agent?: string;
  /** False with `--no-concurrent`: leave out work on other branches and worktrees. */
  concurrent?: boolean;
}

const OPEN_STATUSES = new Set(["active", "paused", "blocked", "proposed"]);

/** Everything known about a task and its related records, ranked, before rendering. */
export interface PreparedTask {
  root: string;
  /** The shared assessment the task and its records were read through. */
  ledger: LedgerAssessment;
  manifest: Manifest;
  git: GitState;
  task: LoadedRecord;
  /** The task's checkpoints, newest first. */
  checkpoints: LoadedRecord[];
  latestRelation?: CheckpointRelation;
  scopePaths: string[];
  records: ScoredCandidate[];
  /** Records that matched but were left out on purpose, with the reason. */
  skipped: Collected["skipped"];
  /** Problems with the ledger that the next agent should know about before trusting it. */
  integrity: IntegrityNotes;
}

export async function prepareTask(
  io: Io,
  options: { task?: string; agent?: string },
): Promise<PreparedTask> {
  const root = await requireInitialized(io);
  const ledger = await assessLedger(root);
  const manifest = requireManifest(ledger);
  const index = ledger.index;

  const git = await readGitState(root, manifest);
  const task = options.task
    ? requireUsable(ledger, options.task, "task", "--task")
    : inferTask(index, options.agent ?? io.env.ALETHIC_AGENT, git.branch);

  // One set of memoized Git lookups for the run: large ledgers repeat the same commits.
  const lookups = createGitLookups(root);
  const collected = await collect(root, index, task, git, manifest, lookups);
  const staleness = await createStalenessContext(root, manifest);
  const receipts = createReceiptContext(root, manifest, git, lookups);
  const assessed: AssessedCandidate[] = [];
  for (const candidate of [...collected.decisions, ...collected.knowledge, ...collected.receipts]) {
    const result = await assessStaleness(staleness, candidate.record.data);
    if (candidate.record.kind !== "receipt") {
      assessed.push({ ...candidate, staleness: result });
      continue;
    }
    const receipt = await assessReceipt(receipts, candidate.record.data);
    assessed.push({
      ...candidate,
      staleness: result,
      receipt,
      atHead: receipt.atHead,
      codeChanged: receipt.codeChanged,
    });
  }

  const latest = collected.checkpoints[0];
  return {
    root,
    ledger,
    manifest,
    git,
    task,
    checkpoints: collected.checkpoints,
    latestRelation: latest
      ? await relationToHead(root, asString(asObject(latest.data.git)?.head), git.head)
      : undefined,
    scopePaths: collected.scopePaths,
    records: rankCandidates(assessed),
    skipped: collected.skipped,
    integrity: await integrityNotes(root, ledger, manifest, task, collected),
  };
}

export async function resumeCommand(io: Io, options: ResumeOptions): Promise<number> {
  const target = options.target ?? "generic";
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new UsageError(`--target must be one of: ${TARGETS.join(", ")}`);
  }
  const format = options.format ?? "md";
  if (format !== "md" && format !== "json") throw new UsageError("--format must be md or json");
  const budgetFlag =
    options.budget === undefined ? undefined : parseInteger(options.budget, "--budget", 200);

  const prepared = await prepareTask(io, options);
  const budget = budgetFlag ?? prepared.manifest.defaults.budget;
  const concurrent =
    options.concurrent === false
      ? []
      : await relevantConcurrentWork(
          prepared.root,
          await gatherConcurrentWork(prepared.root, prepared.ledger),
          prepared.task,
          prepared.manifest.limits.max_glob_matches,
        );
  const briefing = buildBriefing({
    target: target as Target,
    budget,
    now: now(io.env),
    task: prepared.task,
    checkpoints: prepared.checkpoints,
    latestRelation: prepared.latestRelation,
    git: prepared.git,
    scopePaths: prepared.scopePaths,
    records: prepared.records,
    integrity: prepared.integrity,
    concurrent: concurrent.map(concurrentNote),
  });

  if (format === "json") {
    const output = {
      task: briefing.taskId,
      target,
      budget,
      tokens: briefing.tokens,
      overBudget: briefing.overBudget,
      report: briefing.report,
      sections: briefing.sections,
      skipped: prepared.skipped,
      concurrent: concurrent.map(({ source, paths, records }) => ({
        source: source.name,
        ...(source.branch ? { branch: source.branch } : {}),
        ...(source.worktreePath ? { worktree: source.worktreePath } : {}),
        ...(source.committedAt ? { committedAt: source.committedAt } : {}),
        base: source.base,
        uncommitted: source.uncommitted,
        paths,
        records: records.map((entry) => ({
          id: entry.id,
          kind: entry.record.kind,
          uncommitted: entry.uncommitted,
        })),
        withheld: source.withheld,
      })),
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    io.stdout(briefing.text);
  }
  if (briefing.overBudget) {
    const { frame, required, pointers } = briefing.report;
    io.stderr(
      `warning: the briefing is about ${briefing.tokens} tokens, over the budget of about ${budget}. The frame and the sections that are never shortened (goal, repository state, integrity warnings, concurrent work, next safe action) take about ${frame + required}; everything else was reduced to pointer lines, which take about ${pointers}. Read collapsed records with \`alethic show <id>\`.\n`,
    );
  }
  return 0;
}

function concurrentNote({ source, paths, records }: RelevantWork): ConcurrentNote {
  return {
    source: source.name,
    ...(source.worktreePath ? { worktree: source.worktreePath } : {}),
    ...(source.committedAt ? { committedAt: source.committedAt } : {}),
    base: source.base,
    uncommitted: source.uncommitted,
    paths,
    records: records.map(({ record, uncommitted }) => ({ record, uncommitted })),
    withheld: source.withheld,
  };
}

/**
 * What the next agent should know about the ledger itself: records withheld because they failed
 * validation, files that could not be loaded, references the briefing cannot follow, and
 * contradictory decisions that touch this task. Withheld records are listed whatever their
 * relevance, since their content cannot be trusted to decide it.
 */
async function integrityNotes(
  root: string,
  ledger: LedgerAssessment,
  manifest: Manifest,
  task: LoadedRecord,
  collected: Collected,
): Promise<IntegrityNotes> {
  const relevant = [
    task,
    ...collected.checkpoints,
    ...[...collected.decisions, ...collected.knowledge, ...collected.receipts].map((c) => c.record),
  ];
  const relevantIds = new Set(relevant.map(idOf));
  const excludedIds = new Set(ledger.excluded.flatMap((entry) => (entry.id ? [entry.id] : [])));

  const seen = new Set<string>();
  const brokenReferences: IntegrityNotes["brokenReferences"] = [];
  for (const record of relevant) {
    const from = idOf(record);
    for (const ref of collectReferences(record.data)) {
      const key = `${from}\0${ref.id}`;
      if (ledger.index.has(ref.id) || seen.has(key)) continue;
      seen.add(key);
      brokenReferences.push({ from, to: ref.id, excluded: excludedIds.has(ref.id) });
    }
  }

  const pairs = await findContradictionPairs(
    [...ledger.index.values()],
    createOverlapCheck(root, manifest),
  );
  const contradictions = pairs
    .map(({ topic, older, newer }) => ({ topic, ids: [idOf(older), idOf(newer)] as const }))
    .filter(({ ids }) => relevantIds.has(ids[0]) || relevantIds.has(ids[1]))
    .map(({ topic, ids }) => ({ topic, ids: [ids[0], ids[1]] as [string, string] }));

  return {
    excluded: ledger.excluded,
    unloadable: ledger.unloadable,
    contradictions,
    brokenReferences,
  };
}

function idOf(record: LoadedRecord): string {
  return asString(record.data.id) ?? record.file;
}

async function readGitState(root: string, manifest: Manifest): Promise<GitState> {
  const head = await headCommit(root);
  if (!head) return { dirty: await isDirty(root), changedPaths: [] };
  const defaultRef = await resolveBranchRef(root, manifest.defaults.default_branch);
  const baseFull = defaultRef ? await mergeBase(root, head, defaultRef) : undefined;
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  const [branch, dirty, headShort, base, changed] = await Promise.all([
    currentBranch(root),
    isDirty(root),
    shortSha(root, head),
    baseFull ? shortSha(root, baseFull) : Promise.resolve(undefined),
    changedPathsSince(root, baseFull),
  ]);
  return {
    head,
    headShort,
    branch,
    dirty,
    base,
    changedPaths: changed.filter((p) => checkRepoPath(p) === undefined && !forbidden(p)),
  };
}

function inferTask(
  index: ReadonlyMap<string, LoadedRecord>,
  agent: string | undefined,
  branch: string | undefined,
): LoadedRecord {
  const open = [...index.values()].filter(
    (record) => record.kind === "task" && OPEN_STATUSES.has(String(record.data.status)),
  );
  if (agent) {
    const mine = open.filter(
      (record) => record.data.status === "active" && asObject(record.data.owner)?.agent === agent,
    );
    if (mine.length === 1 && mine[0]) return mine[0];
  }
  const onBranch = open.filter((record) => branch !== undefined && record.data.branch === branch);
  if (onBranch.length === 1 && onBranch[0]) return onBranch[0];
  if (open.length === 1 && open[0]) return open[0];
  if (open.length === 0) {
    throw new UsageError("No open tasks to resume. Start one with `alethic task start`.");
  }
  throw new UsageError(
    `Several open tasks. Pass --task <id>: ${open.map((record) => record.data.id).join(", ")}`,
  );
}

async function relationToHead(
  root: string,
  checkpointHead: string | undefined,
  head: string | undefined,
): Promise<CheckpointRelation> {
  const resolved = checkpointHead ? await resolveCommit(root, checkpointHead) : undefined;
  if (!resolved || !head) return { kind: "unavailable" };
  if (resolved === head) return { kind: "head", codeChanged: false };
  const [commits, codeChanged] = await Promise.all([
    commitsSince(root, resolved, head),
    codeChangedBetween(root, resolved, head),
  ]);
  return commits === undefined
    ? { kind: "other-line", codeChanged }
    : { kind: "ahead", commits, codeChanged };
}
