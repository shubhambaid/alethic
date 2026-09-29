import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../core/findings.js";
import { KIND_DIRS, RECORD_KINDS, type RecordKind } from "../core/ids.js";
import { asArray, asObject, asString } from "../core/json.js";
import { ALETHIC_DIR, checkRepoPath, expandScope, isGlob, scopeMatcher } from "../core/paths.js";
import {
  checkRecordEntry,
  type LoadedRecord,
  loadRecords,
  parseRecord,
  type StoreLoad,
} from "../core/store.js";
import { changedPathsSince, headCommit, isDirty, listTrackedFiles, mergeBase } from "../git/git.js";
import {
  changedPathsBetween,
  changedTreeEntries,
  listSources,
  listTreeEntries,
  pathsDifferingFrom,
  readBlobs,
  type TreeEntry,
  type WorkSource,
  worktreeChanges,
} from "../git/sources.js";
import { assessRecords, type LedgerAssessment, type RecordAssessment } from "../validate/assess.js";
import { collectPaths } from "../validate/references.js";

/** A record added or changed on another branch or worktree since it split from this one. */
export interface ConcurrentRecord {
  id: string;
  record: LoadedRecord;
  /** Written in the worktree but not committed there. */
  uncommitted: boolean;
}

export interface ConcurrentSource {
  name: string;
  branch?: string;
  /** Real path of the worktree it is checked out in, when it is in one. */
  worktree?: string;
  /** The same worktree relative to this checkout, for display. */
  worktreePath?: string;
  tip: string;
  /** Committer date of the tip, ISO 8601. */
  committedAt?: string;
  /** Where it split from this line of history: merge-base of HEAD and the tip. */
  base: string;
  /** Usable records added or changed since `base`, by file. */
  records: ConcurrentRecord[];
  /** Records added or changed since `base` that failed the shared checks. Counted, never shown. */
  withheld: number;
  /**
   * Code paths changed since `base`, excluding `.alethic/` and anything matching this checkout's
   * `privacy.forbidden_globs`, sorted.
   */
  changedPaths: string[];
  /** Whether anything in the worktree, records or code, is not committed. */
  uncommitted: boolean;
}

export interface ConcurrentWork {
  /** Sources with anything added or changed since they split from HEAD, by name. */
  sources: ConcurrentSource[];
  /** Sources skipped because they share no history with HEAD here (orphans, shallow clones). */
  unrelated: string[];
  /** Sources not examined because of the limit on how many are read. */
  omitted: number;
}

export const NO_CONCURRENT_WORK: ConcurrentWork = { sources: [], unrelated: [], omitted: 0 };

const RECORD_DIRS = RECORD_KINDS.map((kind) => `${ALETHIC_DIR}/${KIND_DIRS[kind]}`);

/** Sources are read this many at a time: each is a few short git processes. */
const PARALLEL_SOURCES = 4;

function kindOfFile(file: string): RecordKind | undefined {
  const dir = file.slice(0, file.lastIndexOf("/"));
  return RECORD_KINDS.find((kind) => `${ALETHIC_DIR}/${KIND_DIRS[kind]}` === dir);
}

function isRegularFile(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

async function mapPooled<T, R>(
  items: readonly T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/**
 * Work recorded on other local branches and worktrees since they split from HEAD (docs/spec.md
 * §12.1). A record counts when it was added or changed after the two lines of history split, so
 * records both sides inherited are left out. Every record goes through the shared checks, and
 * changed paths through the forbidden-path filter, with this checkout's privacy settings.
 */
export async function gatherConcurrentWork(
  root: string,
  ledger: LedgerAssessment,
): Promise<ConcurrentWork> {
  const head = await headCommit(root);
  if (!head) return NO_CONCURRENT_WORK;
  const { sources, omitted } = await listSources(root);
  const forbidden = scopeMatcher(ledger.settings.privacy.forbidden_globs);
  const shareable = (file: string) => checkRepoPath(file) === undefined && !forbidden(file);

  const read = await mapPooled(sources, PARALLEL_SOURCES, async (source) => {
    const base = await mergeBase(root, head, source.tip);
    if (!base) return { source, unrelated: true as const };
    const read = source.worktree
      ? readWorktree(source, source.worktree, base)
      : readBranch(root, source, base);
    // Changed since the split, but also different from what is here: a squash-merged or
    // cherry-picked branch is not an ancestor of HEAD, yet its content already is.
    const [pending, differing] = await Promise.all([
      read,
      pathsDifferingFrom(
        root,
        head,
        source.worktree ? { worktree: source.worktree } : { tip: source.tip },
      ),
    ]);
    return notHere(pending, differing);
  });
  const unrelated = read.flatMap((entry) => ("unrelated" in entry ? [entry.source.name] : []));
  const pending = read.filter((entry): entry is PendingSource => !("unrelated" in entry));

  // One cat-file process for every branch's changed record files.
  const blobs = await readBlobs(
    root,
    pending.flatMap((source) => source.blobs.map((entry) => entry.object)),
  );

  const results: ConcurrentSource[] = [];
  for (const source of pending) {
    const store: StoreLoad = {
      records: [...source.store.records],
      findings: [...source.store.findings],
    };
    for (const entry of source.blobs) {
      const kind = kindOfFile(entry.file);
      const text = blobs.get(entry.object);
      if (!kind || text === undefined) continue;
      const parsed = parseRecord(entry.file, kind, text);
      if ("problems" in parsed) store.findings.push(...parsed.problems);
      else store.records.push(parsed);
    }
    const assessed = assessRecords(store, ledger.settings, ledger.secretPatterns);
    const records = [...assessed.index.entries()]
      .map(([id, record]) => ({
        id,
        record,
        uncommitted: source.uncommittedFiles.has(record.file),
      }))
      .sort((a, b) => a.record.file.localeCompare(b.record.file));
    const withheld = assessed.excluded.length + assessed.unloadable.length;
    const changedPaths = source.changedPaths.filter(shareable);
    if (records.length === 0 && withheld === 0 && changedPaths.length === 0) continue;
    const { name, branch, worktree, worktreePath, tip, committedAt } = source.source;
    results.push({
      name,
      ...(branch ? { branch } : {}),
      ...(worktree ? { worktree } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      tip,
      ...(committedAt ? { committedAt } : {}),
      base: source.base,
      records,
      withheld,
      changedPaths,
      uncommitted: source.uncommitted,
    });
  }

  return {
    sources: results.sort((a, b) => a.name.localeCompare(b.name)),
    unrelated: unrelated.sort(),
    omitted,
  };
}

/** Keeps only the changes whose content differs from HEAD's. */
function notHere(pending: PendingSource, differing: ReadonlySet<string>): PendingSource {
  const records = pending.store.records.filter((record) => differing.has(record.file));
  const findings = pending.store.findings.filter(
    (finding) => finding.file === undefined || differing.has(finding.file),
  );
  return {
    ...pending,
    store: { records, findings },
    blobs: pending.blobs.filter((entry) => differing.has(entry.file)),
    changedPaths: pending.changedPaths.filter((file) => differing.has(file)),
    uncommitted:
      pending.uncommitted &&
      (records.some((record) => pending.uncommittedFiles.has(record.file)) ||
        pending.changedPaths.some((file) => differing.has(file))),
  };
}

interface PendingSource {
  source: WorkSource;
  base: string;
  /** Records already read (worktrees) and loading findings, before the shared checks. */
  store: StoreLoad;
  /** Changed record files still to read from Git objects (branches). */
  blobs: TreeEntry[];
  changedPaths: string[];
  uncommittedFiles: Set<string>;
  uncommitted: boolean;
}

async function readBranch(root: string, source: WorkSource, base: string): Promise<PendingSource> {
  const findings: Finding[] = [];
  const blobs: TreeEntry[] = [];
  for (const entry of await changedTreeEntries(root, base, source.tip, RECORD_DIRS)) {
    const skip = checkRecordEntry(entry.file, isRegularFile(entry.mode));
    if (skip === "ignore") continue;
    if (skip) findings.push(skip);
    else blobs.push(entry);
  }
  return {
    source,
    base,
    store: { records: [], findings },
    blobs,
    changedPaths: await changedPathsBetween(root, base, source.tip),
    uncommittedFiles: new Set(),
    uncommitted: false,
  };
}

/** Reads only the record files that differ from `base`, from the worktree's directory. */
async function readWorktree(source: WorkSource, dir: string, base: string): Promise<PendingSource> {
  const changes = await worktreeChanges(dir, base, RECORD_DIRS);
  const records: LoadedRecord[] = [];
  const findings: Finding[] = [];
  for (const file of changes.changed) {
    const kind = kindOfFile(file);
    const info = await lstat(path.join(dir, file)).catch(() => undefined);
    if (!kind || !info) continue;
    const skip = checkRecordEntry(file, info.isFile());
    if (skip === "ignore") continue;
    if (skip) {
      findings.push(skip);
      continue;
    }
    const parsed = parseRecord(file, kind, await readFile(path.join(dir, file), "utf8"));
    if ("problems" in parsed) findings.push(...parsed.problems);
    else records.push(parsed);
  }
  const [changedPaths, dirty] = await Promise.all([changedPathsSince(dir, base), isDirty(dir)]);
  return {
    source,
    base,
    store: { records, findings },
    blobs: [],
    changedPaths,
    uncommittedFiles: changes.uncommitted,
    uncommitted: dirty || changes.changed.some((file) => changes.uncommitted.has(file)),
  };
}

/**
 * Every record on one branch or worktree, through the shared checks with this checkout's
 * privacy settings. Used to show a record a concurrent-work notice cited.
 */
export async function assessSource(
  root: string,
  ledger: LedgerAssessment,
  source: WorkSource,
): Promise<RecordAssessment & { store: StoreLoad }> {
  let store: StoreLoad;
  if (source.worktree) {
    store = await loadRecords(source.worktree);
  } else {
    const findings: Finding[] = [];
    const wanted: TreeEntry[] = [];
    const entries = (await listTreeEntries(root, source.tip, RECORD_DIRS)).sort((a, b) =>
      a.file.localeCompare(b.file),
    );
    for (const entry of entries) {
      const skip = checkRecordEntry(entry.file, isRegularFile(entry.mode));
      if (skip === "ignore") continue;
      if (skip) findings.push(skip);
      else wanted.push(entry);
    }
    const blobs = await readBlobs(
      root,
      wanted.map((entry) => entry.object),
    );
    const records: LoadedRecord[] = [];
    for (const entry of wanted) {
      const kind = kindOfFile(entry.file);
      const text = blobs.get(entry.object);
      if (!kind || text === undefined) continue;
      const parsed = parseRecord(entry.file, kind, text);
      if ("problems" in parsed) findings.push(...parsed.problems);
      else records.push(parsed);
    }
    store = { records, findings };
  }
  return { ...assessRecords(store, ledger.settings, ledger.secretPatterns), store };
}

/** What another source has that touches the task being resumed. */
export interface RelevantWork {
  source: ConcurrentSource;
  /** Code paths changed there that are inside the task's scope. */
  paths: string[];
  /** Records about the task's scope, or about the task itself, in display order. */
  records: ConcurrentRecord[];
}

const KIND_ORDER: Record<RecordKind, number> = {
  task: 1,
  checkpoint: 2,
  decision: 3,
  knowledge: 4,
  receipt: 5,
};

function time(iso: string | undefined): number {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

/**
 * The part of the concurrent work that touches a task: changed files inside its scope, records
 * whose paths overlap the scope, and anything recorded about the task itself. Paths are matched
 * in both directions, so a file that exists only on the other branch still counts.
 */
export async function relevantConcurrentWork(
  root: string,
  work: ConcurrentWork,
  task: LoadedRecord,
  maxGlobMatches: number,
): Promise<RelevantWork[]> {
  if (work.sources.length === 0) return [];
  const taskId = asString(task.data.id);
  const patterns = strings(asObject(task.data.scope)?.paths);
  const ours = scopeMatcher(patterns);
  const ourFiles = [
    ...patterns.filter((pattern) => !isGlob(pattern)),
    ...(patterns.length > 0
      ? expandScope(await listTrackedFiles(root), patterns, maxGlobMatches).files
      : []),
  ];
  const touchesScope = (paths: readonly string[]) => {
    if (paths.length === 0 || patterns.length === 0) return false;
    if (paths.some((path) => ours(path))) return true;
    const theirs = scopeMatcher(paths);
    return ourFiles.some((file) => theirs(file));
  };
  const aboutTask = (record: LoadedRecord) =>
    asString(record.data.id) === taskId ||
    (record.kind === "checkpoint" && record.data.task === taskId);

  const relevant: RelevantWork[] = [];
  for (const source of work.sources) {
    const paths = patterns.length > 0 ? source.changedPaths.filter((path) => ours(path)) : [];
    const records = source.records
      .filter(
        (entry) =>
          aboutTask(entry.record) ||
          (entry.record.kind !== "checkpoint" &&
            entry.record.kind !== "receipt" &&
            touchesScope(collectPaths(entry.record.data).map((field) => field.value))),
      )
      .sort(
        (a, b) =>
          Number(aboutTask(b.record)) - Number(aboutTask(a.record)) ||
          KIND_ORDER[a.record.kind] - KIND_ORDER[b.record.kind] ||
          a.id.localeCompare(b.id),
      );
    if (paths.length === 0 && records.length === 0) continue;
    relevant.push({ source, paths, records });
  }
  // Live worktrees first, then the most recently committed, so an abandoned branch cannot hold
  // a place ahead of current work; then the most overlap, then name.
  return relevant.sort(
    (a, b) =>
      Number(b.source.worktree !== undefined) - Number(a.source.worktree !== undefined) ||
      time(b.source.committedAt) - time(a.source.committedAt) ||
      b.paths.length + b.records.length - (a.paths.length + a.records.length) ||
      a.source.name.localeCompare(b.source.name),
  );
}
