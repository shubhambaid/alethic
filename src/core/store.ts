import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { UsageError } from "./errors.js";
import type { Finding } from "./findings.js";
import { parseYaml, stringifyRecord, yamlFinding } from "./format.js";
import { KIND_DIRS, RECORD_KINDS, type RecordKind } from "./ids.js";
import { isPlainObject } from "./json.js";
import { ALETHIC_DIR } from "./paths.js";

export interface LoadedRecord {
  /** Repository-relative path, e.g. `.alethic/tasks/task-x.yaml`. */
  file: string;
  /** Kind implied by the directory the file is in. */
  kind: RecordKind;
  data: Record<string, unknown>;
  /** Raw file content, used for append-only checks and to detect competing writes. */
  text: string;
}

export interface StoreLoad {
  records: LoadedRecord[];
  findings: Finding[];
}

export function recordFile(kind: RecordKind, id: string): string {
  return `${ALETHIC_DIR}/${KIND_DIRS[kind]}/${id}.yaml`;
}

/** Loads every record file. Files that are not parseable YAML mappings become findings instead. */
export async function loadRecords(root: string): Promise<StoreLoad> {
  const records: LoadedRecord[] = [];
  const findings: Finding[] = [];

  for (const kind of RECORD_KINDS) {
    const dir = `${ALETHIC_DIR}/${KIND_DIRS[kind]}`;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${dir}/${entry.name}`;
      const skip = checkRecordEntry(file, entry.isFile());
      if (skip === "ignore") continue;
      if (skip) {
        findings.push(skip);
        continue;
      }
      const parsed = parseRecord(file, kind, await readFile(path.join(root, file), "utf8"));
      if ("problems" in parsed) findings.push(...parsed.problems);
      else records.push(parsed);
    }
  }
  return { records, findings };
}

/**
 * Whether an entry in a record directory should be read as a record: undefined for a `.yaml`
 * file, "ignore" for `.gitkeep`, otherwise the finding that explains why it is not a record.
 * Shared by every way of listing records, so a record read from another branch is judged by the
 * same rules as one in this checkout.
 */
export function checkRecordEntry(file: string, isFile: boolean): Finding | "ignore" | undefined {
  const name = path.posix.basename(file);
  if (name === ".gitkeep") return "ignore";
  if (!isFile) {
    return {
      severity: "warning",
      code: "unexpected-file",
      file,
      message: "Unexpected non-file entry in a record directory",
    };
  }
  if (name.endsWith(".yml")) {
    return {
      severity: "error",
      code: "wrong-extension",
      file,
      message: "Record files must use the .yaml extension",
      hint: `Rename it to ${name.slice(0, -4)}.yaml.`,
    };
  }
  if (!name.endsWith(".yaml")) {
    return {
      severity: "warning",
      code: "unexpected-file",
      file,
      message: name.endsWith(".lock")
        ? "A write lock left behind by an interrupted alethic command"
        : "Ignoring a file that is not a .yaml record",
      ...(name.endsWith(".lock") ? { hint: "If no alethic command is running, delete it." } : {}),
    };
  }
  return undefined;
}

/** Parses one record file's content. Anything but a single YAML mapping becomes findings. */
export function parseRecord(
  file: string,
  kind: RecordKind,
  text: string,
): LoadedRecord | { problems: Finding[] } {
  const parsed = parseYaml(text);
  if (parsed.problems.length > 0) {
    return { problems: parsed.problems.map((problem) => yamlFinding(file, problem)) };
  }
  if (!isPlainObject(parsed.data)) {
    return {
      problems: [
        { severity: "error", code: "yaml", file, message: "A record must be a YAML mapping" },
      ],
    };
  }
  return { file, kind, data: parsed.data, text };
}

export interface WriteOptions {
  /** Replace an existing file. Without it, creating a record that exists fails. */
  overwrite?: boolean;
  /**
   * The file content the change was based on. When the file no longer has this content, another
   * writer changed it in between, and nothing is written.
   */
  expected?: string;
}

/** A lock older than this is reported as left behind rather than as a write in progress. */
const STALE_LOCK_MS = 30_000;

/**
 * Writes a record through a temporary file, so readers never see a partial record, and so
 * competing writers on the same working tree cannot silently lose each other's changes:
 *
 * - Creating (no `overwrite`) links the temporary file into place, which fails atomically when
 *   the record already exists, even if another process created it a moment ago.
 * - Replacing takes a lock file next to the record, checks the current content against
 *   `expected`, then renames. A stale writer gets an error instead of overwriting newer content.
 *
 * This protects writers sharing one working tree. Separate clones and branches are reconciled by
 * Git merges (docs/spec.md §11), not by these locks.
 */
export async function writeRecord(
  root: string,
  kind: RecordKind,
  record: Record<string, unknown>,
  options: WriteOptions = {},
): Promise<string> {
  const id = record.id;
  if (typeof id !== "string") throw new Error("record.id must be a string");
  const file = recordFile(kind, id);
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, stringifyRecord(record), "utf8");

  try {
    if (!options.overwrite) {
      try {
        await link(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new UsageError(`${file} already exists`);
        }
        throw error;
      }
      return file;
    }

    const release = await acquireLock(target, file);
    try {
      if (options.expected !== undefined) {
        const current = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current !== options.expected) {
          throw new UsageError(
            `${file} changed after this command read it, probably because another agent or session wrote it. Nothing was written; run the command again to apply the change to the current version.`,
          );
        }
      }
      await rename(temp, target);
    } finally {
      await release();
    }
    return file;
  } finally {
    await rm(temp, { force: true });
  }
}

async function acquireLock(target: string, file: string): Promise<() => Promise<void>> {
  const lock = `${target}.lock`;
  try {
    const handle = await open(lock, "wx");
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await stat(lock).catch(() => undefined);
    const age = info ? Date.now() - info.mtimeMs : 0;
    throw new UsageError(
      age > STALE_LOCK_MS
        ? `${file}.lock was left behind by an interrupted write ${Math.round(age / 1000)} seconds ago. If no alethic command is running, delete it and try again.`
        : `${file} is being written by another alethic command. Nothing was written; try again in a moment.`,
    );
  }
  return () => rm(lock, { force: true });
}
