import { now } from "../core/clock.js";
import { describeWriter } from "../core/identity.js";
import { RECORD_KINDS, type RecordKind } from "../core/ids.js";
import { asObject, asString } from "../core/json.js";
import type { LoadedRecord } from "../core/store.js";
import { currentBranch, headCommit, isDirty } from "../git/git.js";
import { MAX_SOURCES } from "../git/sources.js";
import {
  type ConcurrentSource,
  type ConcurrentWork,
  gatherConcurrentWork,
} from "../trust/concurrent.js";
import { assessLedger } from "../validate/assess.js";
import { validateRepository } from "../validate/index.js";
import { type Io, requireInitialized } from "./context.js";
import { plural } from "./output.js";

export interface StatusOptions {
  json?: boolean;
  /** Also list work on other local branches and worktrees (spec §12.1). */
  allBranches?: boolean;
}

export interface TaskSummary {
  id: string;
  status: string;
  summary: string;
  owner: string | null;
  ownerSession: string | null;
  leaseExpiresAt: string | null;
  leaseExpired: boolean;
  nextAction: string | null;
  latestCheckpoint: { id: string; createdAt: string } | null;
}

const OPEN_STATUSES = new Set(["proposed", "paused", "blocked"]);

export async function statusCommand(io: Io, options: StatusOptions): Promise<number> {
  const root = await requireInitialized(io);
  const at = now(io.env);
  const ledger = await assessLedger(root);
  const [report, head, branch, dirty] = await Promise.all([
    validateRepository(root, { now: at, ledger }),
    headCommit(root),
    currentBranch(root),
    isDirty(root),
  ]);

  const counts = Object.fromEntries(
    RECORD_KINDS.map((kind) => [kind, report.records.filter((r) => r.kind === kind).length]),
  ) as Record<RecordKind, number>;
  const tasks = report.records
    .filter((record) => record.kind === "task")
    .map((task) => summarizeTask(task, report.records, at))
    .sort((a, b) => a.id.localeCompare(b.id));
  const activeTasks = tasks.filter((task) => task.status === "active");
  const openTasks = tasks.filter((task) => OPEN_STATUSES.has(task.status));

  const status = {
    project: report.manifest?.project.name ?? null,
    git: { branch: branch ?? null, head: head ?? null, dirty },
    counts,
    activeTasks,
    openTasks,
    validation: { valid: report.errors === 0, errors: report.errors, warnings: report.warnings },
    ...(options.allBranches
      ? { concurrent: summarizeConcurrent(await gatherConcurrentWork(root, ledger)) }
      : {}),
  };

  if (options.json) {
    io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `Alethic status: ${status.project ?? "(manifest invalid)"}`,
    `  branch   ${branch ?? "(detached HEAD)"} @ ${head ? head.slice(0, 7) : "no commits"} (${dirty ? "dirty" : "clean"})`,
    `  records  ${[
      plural(counts.task, "task"),
      plural(counts.decision, "decision"),
      plural(counts.knowledge, "knowledge", "knowledge"),
      plural(counts.checkpoint, "checkpoint"),
      plural(counts.receipt, "receipt"),
    ].join(", ")}`,
    "",
    "Active tasks",
  ];
  if (activeTasks.length === 0) lines.push("  none");
  for (const task of activeTasks) {
    lines.push(`  ${task.id}: ${task.summary}`);
    if (task.owner) {
      const owner = describeWriter({
        agent: task.owner,
        ...(task.ownerSession ? { session: task.ownerSession } : {}),
      });
      lines.push(
        `    owner ${owner}, lease until ${task.leaseExpiresAt ?? "?"}${task.leaseExpired ? " (expired)" : ""}`,
      );
    }
    if (task.nextAction) lines.push(`    next: ${task.nextAction}`);
    lines.push(
      `    latest checkpoint: ${task.latestCheckpoint ? `${task.latestCheckpoint.id} (${task.latestCheckpoint.createdAt})` : "none"}`,
    );
  }
  if (openTasks.length > 0) {
    lines.push("", "Other open tasks");
    for (const task of openTasks) lines.push(`  ${task.id} [${task.status}]: ${task.summary}`);
  }
  if (status.concurrent) lines.push("", ...concurrentLines(status.concurrent));
  lines.push(
    "",
    report.errors === 0
      ? `Validation: ok (${plural(report.warnings, "warning")})`
      : `Validation: ${plural(report.errors, "error")}, ${plural(report.warnings, "warning")}. Run \`alethic validate\` for details.`,
  );
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

function summarizeTask(
  task: LoadedRecord,
  records: readonly LoadedRecord[],
  at: Date,
): TaskSummary {
  const id = asString(task.data.id) ?? task.file;
  const owner = asObject(task.data.owner);
  const lease = asString(owner?.lease_expires_at) ?? null;
  const checkpoints = records
    .filter((record) => record.kind === "checkpoint" && record.data.task === id)
    .map((record) => ({
      id: asString(record.data.id) ?? record.file,
      createdAt: asString(record.data.created_at) ?? "",
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

  return {
    id,
    status: asString(task.data.status) ?? "unknown",
    summary: asString(task.data.summary) ?? "",
    owner: asString(owner?.agent) ?? null,
    ownerSession: asString(owner?.session) ?? null,
    leaseExpiresAt: lease,
    leaseExpired: lease !== null && Date.parse(lease) <= at.getTime(),
    nextAction: asString(task.data.next_action) ?? null,
    latestCheckpoint: checkpoints[0] ?? null,
  };
}

export interface ConcurrentSummary {
  source: string;
  branch: string | null;
  /** Relative to this checkout. */
  worktree: string | null;
  /** Committer date of the tip, ISO 8601. */
  committedAt: string | null;
  tip: string;
  base: string;
  uncommitted: boolean;
  changedPaths: string[];
  tasks: {
    id: string;
    status: string;
    summary: string;
    owner: string | null;
    uncommitted: boolean;
  }[];
  decisions: {
    id: string;
    status: string;
    topic: string | null;
    chosen: string;
    uncommitted: boolean;
  }[];
  knowledge: { id: string; summary: string; uncommitted: boolean }[];
  checkpoints: number;
  receipts: number;
  withheld: number;
}

/**
 * Work on other branches and worktrees, from usable records only: a record withheld by the
 * shared checks is counted, and nothing from its content is shown (spec §12.1, §14).
 */
function summarizeConcurrent(work: ConcurrentWork): {
  sources: ConcurrentSummary[];
  unrelated: string[];
  omitted: number;
} {
  return {
    sources: work.sources.map(summarizeSource),
    unrelated: work.unrelated,
    omitted: work.omitted,
  };
}

function summarizeSource(source: ConcurrentSource): ConcurrentSummary {
  const of = (kind: RecordKind) => source.records.filter((entry) => entry.record.kind === kind);
  return {
    source: source.name,
    branch: source.branch ?? null,
    worktree: source.worktreePath ?? null,
    committedAt: source.committedAt ?? null,
    tip: source.tip,
    base: source.base,
    uncommitted: source.uncommitted,
    changedPaths: source.changedPaths,
    tasks: of("task").map(({ id, record, uncommitted }) => ({
      id,
      status: asString(record.data.status) ?? "unknown",
      summary: asString(record.data.summary) ?? "",
      owner: asString(asObject(record.data.owner)?.agent) ?? null,
      uncommitted,
    })),
    decisions: of("decision").map(({ id, record, uncommitted }) => ({
      id,
      status: asString(record.data.status) ?? "unknown",
      topic: asString(record.data.topic) ?? null,
      chosen: asString(record.data.chosen) ?? "",
      uncommitted,
    })),
    knowledge: of("knowledge").map(({ id, record, uncommitted }) => ({
      id,
      summary: asString(record.data.summary) ?? "",
      uncommitted,
    })),
    checkpoints: of("checkpoint").length,
    receipts: of("receipt").length,
    withheld: source.withheld,
  };
}

const MAX_LISTED_PATHS = 5;

function concurrentLines(concurrent: {
  sources: ConcurrentSummary[];
  unrelated: string[];
  omitted: number;
}): string[] {
  const lines = ["Other branches and worktrees (changes since each split from this branch)"];
  if (concurrent.sources.length === 0) lines.push("  none");
  for (const source of concurrent.sources) {
    const where = source.worktree
      ? ` (worktree ${source.worktree}${source.uncommitted ? ", uncommitted changes" : ""})`
      : "";
    const last = source.committedAt ? `, last commit ${source.committedAt.slice(0, 10)}` : "";
    lines.push(`  ${source.source}${where}, split at ${source.base.slice(0, 7)}${last}`);
    if (source.changedPaths.length > 0) {
      const shown = source.changedPaths.slice(0, MAX_LISTED_PATHS).join(", ");
      const more = source.changedPaths.length - MAX_LISTED_PATHS;
      lines.push(
        `    ${plural(source.changedPaths.length, "file")} changed: ${shown}${more > 0 ? `, and ${more} more` : ""}`,
      );
    }
    const mark = (uncommitted: boolean) => (uncommitted ? " (uncommitted)" : "");
    for (const task of source.tasks) {
      lines.push(
        `    task ${task.id} [${task.status}]${task.owner ? ` ${task.owner}` : ""}: ${task.summary}${mark(task.uncommitted)}`,
      );
    }
    for (const decision of source.decisions) {
      lines.push(
        `    decision ${decision.id} [${decision.status}]${decision.topic ? ` ${decision.topic}` : ""}: ${decision.chosen}${mark(decision.uncommitted)}`,
      );
    }
    for (const knowledge of source.knowledge) {
      lines.push(
        `    knowledge ${knowledge.id}: ${knowledge.summary}${mark(knowledge.uncommitted)}`,
      );
    }
    const other = [
      source.checkpoints > 0 ? plural(source.checkpoints, "checkpoint") : "",
      source.receipts > 0 ? plural(source.receipts, "receipt") : "",
    ].filter(Boolean);
    if (other.length > 0) lines.push(`    ${other.join(", ")}`);
    if (source.withheld > 0) {
      lines.push(
        `    ${plural(source.withheld, "record")} failed validation and ${source.withheld === 1 ? "is" : "are"} not shown`,
      );
    }
  }
  if (concurrent.unrelated.length > 0) {
    lines.push(
      `  Skipped, no shared history with this branch here: ${concurrent.unrelated.join(", ")}`,
    );
  }
  if (concurrent.omitted > 0) {
    lines.push(
      `  ${plural(concurrent.omitted, "more source")} not examined (limit ${MAX_SOURCES})`,
    );
  }
  return lines;
}
