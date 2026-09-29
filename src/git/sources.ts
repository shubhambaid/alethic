import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { GitError, git } from "./git.js";

/**
 * Other lines of work in this clone: local branches not yet merged into HEAD, and other
 * worktrees. Read from Git objects and, for worktrees, from their directories; nothing is
 * checked out and nothing is fetched (docs/spec.md §12.1).
 */
export interface WorkSource {
  /** The branch name, or `worktree <relative path>` for a worktree with a detached HEAD. */
  name: string;
  branch?: string;
  /** The commit the source is at: the branch tip, or the worktree's HEAD. */
  tip: string;
  /** Committer date of `tip`, ISO 8601. */
  committedAt?: string;
  /** Real path of the worktree the source is checked out in, when it is in one. */
  worktree?: string;
  /** The same worktree, relative to this checkout's real path, for display. */
  worktreePath?: string;
}

export interface SourceList {
  sources: WorkSource[];
  /** Sources left out because of the limit. */
  omitted: number;
}

/** At most this many other branches and worktrees are examined per command. */
export const MAX_SOURCES = 25;

/**
 * Other worktrees first (they are where agents are working now), then branches not merged into
 * HEAD, most recently committed first. The current worktree is never a source, and a branch is
 * read from its worktree only while that worktree still exists.
 */
export async function listSources(root: string, limit: number = MAX_SOURCES): Promise<SourceList> {
  const here = await realpath(root);
  const worktrees: WorkSource[] = [];
  const readFromWorktree = new Set<string>();
  for (const entry of await listWorktrees(root)) {
    const dir = await usableWorktree(entry);
    if (!dir) continue;
    // The current branch is never a source, even while it is checked out here.
    if (entry.branch) readFromWorktree.add(entry.branch);
    if (dir === here || !entry.head) continue;
    worktrees.push(worktreeSource(here, dir, entry.head, entry.branch));
  }
  worktrees.sort((a, b) => a.name.localeCompare(b.name));

  const branches: WorkSource[] = [];
  const refs = await git(root, [
    "for-each-ref",
    "--no-merged=HEAD",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)",
    "refs/heads",
  ]);
  if (refs.code === 0) {
    for (const line of refs.stdout.split("\n")) {
      const [branch, tip, committedAt] = line.split("\0");
      if (!branch || !tip || readFromWorktree.has(branch)) continue;
      branches.push({ name: branch, branch, tip, ...(committedAt ? { committedAt } : {}) });
    }
  }

  const sources = [...worktrees, ...branches].slice(0, limit);
  const dates = await commitDates(
    root,
    sources.filter((source) => !source.committedAt).map((source) => source.tip),
  );
  for (const source of sources) {
    const date = source.committedAt ?? dates.get(source.tip);
    if (date) source.committedAt = date;
  }
  return {
    sources,
    omitted: Math.max(0, worktrees.length + branches.length - limit),
  };
}

/**
 * The branch or worktree a user named, for reading records from it: a worktree path (relative to
 * this checkout or absolute, with or without the `worktree ` prefix citations use), a branch
 * checked out in a worktree (read from that worktree), or any local branch (read from its tip).
 * Undefined when it names none of these.
 */
export async function findSource(root: string, ref: string): Promise<WorkSource | undefined> {
  const here = await realpath(root);
  const pathLike = ref.replace(/^worktree /, "");
  const named = await realpath(resolve(here, pathLike)).catch(() => undefined);
  for (const entry of await listWorktrees(root)) {
    const dir = await usableWorktree(entry);
    if (!dir || !entry.head || (entry.branch !== ref && dir !== named)) continue;
    const source = worktreeSource(here, dir, entry.head, entry.branch);
    const date = (await commitDates(root, [entry.head])).get(entry.head);
    return date ? { ...source, committedAt: date } : source;
  }
  const tip = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`]);
  if (tip.code !== 0) return undefined;
  const sha = tip.stdout.trim();
  const date = (await commitDates(root, [sha])).get(sha);
  return { name: ref, branch: ref, tip: sha, ...(date ? { committedAt: date } : {}) };
}

function worktreeSource(here: string, dir: string, head: string, branch?: string): WorkSource {
  const display = relative(here, dir) || ".";
  return {
    name: branch ?? `worktree ${display}`,
    ...(branch ? { branch } : {}),
    tip: head,
    worktree: dir,
    worktreePath: display,
  };
}

/** The worktree's real path, unless it is bare, marked prunable, or its directory is gone. */
async function usableWorktree(entry: WorktreeEntry): Promise<string | undefined> {
  if (entry.bare || entry.prunable) return undefined;
  const dir = await realpath(entry.path).catch(() => undefined);
  if (!dir) return undefined;
  const isDir = await stat(dir)
    .then((info) => info.isDirectory())
    .catch(() => false);
  return isDir ? dir : undefined;
}

/** Committer dates of commits, from one git process. */
async function commitDates(root: string, commits: readonly string[]): Promise<Map<string, string>> {
  const dates = new Map<string, string>();
  const unique = [...new Set(commits)];
  if (unique.length === 0) return dates;
  const result = await git(root, ["log", "--no-walk=unsorted", "--format=%H%x00%cI", ...unique]);
  if (result.code !== 0) return dates;
  for (const line of result.stdout.split("\n")) {
    const [sha, date] = line.split("\0");
    if (sha && date) dates.set(sha, date);
  }
  return dates;
}

interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  prunable: boolean;
}

async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  const result = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  if (result.code !== 0) return [];
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of result.stdout.split("\0")) {
    if (field === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      current = { path: value, bare: false, prunable: false };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (current && key === "bare") {
      current.bare = true;
    } else if (current && key === "prunable") {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface TreeEntry {
  /** Repository-relative path. */
  file: string;
  mode: string;
  object: string;
}

/** Entries directly inside the given directories of a commit's tree, without recursing. */
export async function listTreeEntries(
  root: string,
  commit: string,
  dirs: readonly string[],
): Promise<TreeEntry[]> {
  const result = await git(root, ["ls-tree", "-z", commit, "--", ...dirs.map((dir) => `${dir}/`)]);
  if (result.code !== 0) {
    throw new GitError(`git ls-tree ${commit} failed: ${result.stderr.trim()}`);
  }
  const entries: TreeEntry[] = [];
  for (const line of result.stdout.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const [mode, , object] = line.slice(0, tab).split(" ");
    if (mode && object) entries.push({ file: line.slice(tab + 1), mode, object });
  }
  return entries;
}

/** Paths that differ between two commits, excluding `.alethic/`, sorted. */
export async function changedPathsBetween(
  root: string,
  from: string,
  to: string,
): Promise<string[]> {
  const result = await git(root, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    from,
    to,
    "--",
    ".",
    ":(exclude).alethic",
  ]);
  if (result.code !== 0) {
    throw new GitError(`git diff ${from} ${to} failed: ${result.stderr.trim()}`);
  }
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

/**
 * Entries under the given directories (not recursing into subdirectories) that were added or
 * changed between two commits, with their mode and blob id at `to`. Deleted entries are left out.
 */
export async function changedTreeEntries(
  root: string,
  from: string,
  to: string,
  dirs: readonly string[],
): Promise<TreeEntry[]> {
  const result = await git(root, [
    "diff",
    "--raw",
    "-z",
    "--no-renames",
    "--no-abbrev",
    from,
    to,
    "--",
    ...dirs.map((dir) => `${dir}/`),
  ]);
  if (result.code !== 0) {
    throw new GitError(`git diff ${from} ${to} failed: ${result.stderr.trim()}`);
  }
  const fields = result.stdout.split("\0");
  const entries: TreeEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , object, status] = (fields[i] ?? "").split(" ");
    const file = fields[i + 1];
    if (!file || !mode || !object || status === "D") continue;
    if (!dirs.includes(file.slice(0, file.lastIndexOf("/")))) continue;
    entries.push({ file, mode, object });
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * For a worktree: files under the given directories that differ from `base` (committed since,
 * modified, or untracked), and which of those are not committed in the worktree. Only files
 * directly inside the directories; nothing is hashed, so large ledgers stay cheap.
 */
export async function worktreeChanges(
  dir: string,
  base: string,
  dirs: readonly string[],
): Promise<{ changed: string[]; uncommitted: Set<string> }> {
  const specs = dirs.map((d) => `${d}/`);
  const inDirs = (file: string) => dirs.includes(file.slice(0, file.lastIndexOf("/")));
  const [diff, untracked, status] = await Promise.all([
    git(dir, ["diff", "--name-only", "-z", "--no-renames", base, "--", ...specs]),
    git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...specs]),
    git(dir, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
      "--",
      ...specs,
    ]),
  ]);
  for (const result of [diff, untracked, status]) {
    if (result.code !== 0) throw new GitError(`git in ${dir} failed: ${result.stderr.trim()}`);
  }
  const changed = new Set<string>();
  for (const file of [...diff.stdout.split("\0"), ...untracked.stdout.split("\0")]) {
    if (file && inDirs(file)) changed.add(file);
  }
  const uncommitted = new Set<string>();
  for (const entry of status.stdout.split("\0")) {
    const file = entry.slice(3);
    if (entry.length > 3 && inDirs(file)) uncommitted.add(file);
  }
  return { changed: [...changed].sort((a, b) => a.localeCompare(b)), uncommitted };
}

/**
 * Every path whose content at `tip` (a commit) or in `worktree` (its working tree, including
 * untracked files) differs from `commit`. Used to drop work that is already here, such as a
 * branch that was squash-merged or cherry-picked, which merge-base ancestry cannot see.
 */
export async function pathsDifferingFrom(
  root: string,
  commit: string,
  other: { tip: string } | { worktree: string },
): Promise<Set<string>> {
  const differing = new Set<string>();
  const add = (output: string) => {
    for (const file of output.split("\0")) if (file) differing.add(file);
  };
  if ("tip" in other) {
    const result = await git(root, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      commit,
      other.tip,
    ]);
    if (result.code !== 0) throw new GitError(`git diff failed: ${result.stderr.trim()}`);
    add(result.stdout);
    return differing;
  }
  const [diff, untracked] = await Promise.all([
    git(other.worktree, ["diff", "--name-only", "-z", "--no-renames", commit]),
    git(other.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  for (const result of [diff, untracked]) {
    if (result.code !== 0)
      throw new GitError(`git in ${other.worktree} failed: ${result.stderr.trim()}`);
    add(result.stdout);
  }
  return differing;
}

/**
 * Contents of many blobs from one `git cat-file --batch` process. Missing objects are left out
 * of the result. Git processes dominate command time, so reading a branch's records one process
 * per file would not scale (docs/performance.md).
 */
export async function readBlobs(
  root: string,
  objects: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(objects)];
  const contents = new Map<string, string>();
  if (wanted.length === 0) return contents;

  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new GitError("git is not installed or not on PATH") : error),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new GitError(`git cat-file --batch failed: ${stderr.trim()}`));
    });
    child.stdin.end(`${wanted.join("\n")}\n`);
  });

  let offset = 0;
  for (const object of wanted) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = output.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") {
      contents.set(object, output.subarray(offset, offset + size).toString("utf8"));
    }
    offset += size + 1;
  }
  return contents;
}
