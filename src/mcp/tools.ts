import { writeFile } from "node:fs/promises";
import path from "node:path";
import { TARGETS } from "../compile/briefing.js";
import { UsageError } from "../core/errors.js";

type Args = Record<string, unknown>;
type Schema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /** Exit codes that are an answer rather than a failure (validate exits 1 when it finds errors). */
  okCodes?: readonly number[];
  /**
   * Builds CLI arguments, so every tool runs the same command code as the CLI: schema checks,
   * path safety, and the secret scan included. Values use `--flag=value` and positionals follow
   * `--`, so an argument can never be read as another option.
   */
  argv: (args: Args, scratchDir: () => Promise<string>) => Promise<string[]>;
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const text = (description: string, maxLength = 4000): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});
const list = (description: string, items: Schema = text("", 4000)): Schema => ({
  type: "array",
  items,
  maxItems: 100,
  description,
});
const pair = (left: string, right: string, description: string): Schema =>
  list(description, {
    type: "object",
    properties: { [left]: text(""), [right]: text("") },
    required: [left, right],
    additionalProperties: false,
  });
const AGENT = text("agent writing the record (default: the server's ALETHIC_AGENT)", 64);
const PATHS = list("repository paths or globs", text("", 512));

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

function opt(flag: string, value: unknown): string[] {
  return value === undefined ? [] : [`--${flag}=${String(value)}`];
}

function many(flag: string, values: unknown): string[] {
  return Array.isArray(values) ? values.map((value) => `--${flag}=${String(value)}`) : [];
}

function bool(flag: string, value: unknown): string[] {
  return value === true ? [`--${flag}`] : [];
}

function pairs(flag: string, values: unknown, left: string, right: string): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value: Args) => {
    const first = String(value[left]);
    if (first.includes("::")) throw new UsageError(`${left} must not contain "::"`);
    return `--${flag}=${first}::${String(value[right])}`;
  });
}

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "resume",
    title: "Resume a task",
    description:
      "Compile a cited briefing for continuing a task: goal, repository state, decisions, checks, failed approaches, open questions, and the next safe action. Call before non-trivial work. The budget is approximate (characters / 4).",
    inputSchema: object({
      task: text("task id (default: your active task, or the only open task)", 200),
      target: { type: "string", enum: [...TARGETS], description: "agent reading the briefing" },
      budget: { type: "integer", minimum: 200, maximum: 100000, description: "approximate tokens" },
      agent: AGENT,
    }),
    annotations: READ,
    argv: async (a) => [
      "resume",
      ...opt("task", a.task),
      ...opt("target", a.target),
      ...opt("budget", a.budget),
      ...opt("agent", a.agent),
    ],
  },
  {
    name: "status",
    title: "Repository and task status",
    description:
      "Git state, active tasks with lease owners, latest checkpoints, and validation. With all_branches, also tasks, decisions, and changed files on other local branches and worktrees since they split from this one.",
    inputSchema: object({
      all_branches: {
        type: "boolean",
        description: "include work on other local branches and worktrees",
      },
    }),
    annotations: READ,
    argv: async (a) => ["status", "--json", ...(a.all_branches === true ? ["--all-branches"] : [])],
  },
  {
    name: "search",
    title: "Search records",
    description:
      "Find decisions, knowledge, checkpoints (including failed approaches), tasks, and receipts by words, or by meaning when semantic search is enabled. Call before starting work that shares no files with your task, to learn whether someone already decided or tried it. Results carry freshness and trust; read one in full with the show tool or `alethic show`.",
    inputSchema: object(
      {
        query: text("what to look for, in plain words", 500),
        kind: {
          type: "array",
          items: {
            type: "string",
            enum: ["task", "decision", "knowledge", "checkpoint", "receipt"],
          },
          maxItems: 5,
          description: "only these record kinds",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "most results (default 8)",
        },
      },
      ["query"],
    ),
    annotations: READ,
    argv: async (a) => [
      "search",
      "--json",
      ...many("kind", a.kind),
      ...opt("limit", a.limit),
      "--",
      String(a.query),
    ],
  },
  {
    name: "validate",
    title: "Validate records",
    description:
      "Check .alethic/ for schema, provenance, privacy, and lease problems. Run before closing a task. Findings are returned, not raised as errors.",
    inputSchema: object({ strict: { type: "boolean", description: "missing commits are errors" } }),
    annotations: READ,
    okCodes: [0, 1],
    argv: async (a) => ["validate", "--json", ...bool("strict", a.strict)],
  },
  {
    name: "task_start",
    title: "Start a task",
    description: "Create an active task owned by the calling agent, with an expiring lease.",
    inputSchema: object(
      {
        intent: text("what should be true when the task is done, and why"),
        summary: text("one-line summary", 280),
        paths: PATHS,
        branch: text("branch where the work happens", 200),
        next: text("the next concrete step"),
        id: text("record id", 200),
        agent: AGENT,
      },
      ["intent"],
    ),
    annotations: WRITE,
    argv: async (a) => [
      "task",
      "start",
      "--json",
      ...opt("summary", a.summary),
      ...many("paths", a.paths),
      ...opt("branch", a.branch),
      ...opt("next", a.next),
      ...opt("id", a.id),
      ...opt("agent", a.agent),
      "--",
      String(a.intent),
    ],
  },
  {
    name: "task_claim",
    title: "Claim a task",
    description:
      "Take ownership of a task or renew your lease. Fails while another agent's lease is unexpired unless force is set.",
    inputSchema: object(
      {
        id: text("task id", 200),
        force: { type: "boolean", description: "take over an unexpired lease" },
        agent: AGENT,
      },
      ["id"],
    ),
    annotations: { ...WRITE, idempotentHint: true },
    argv: async (a) => [
      "task",
      "claim",
      "--json",
      ...bool("force", a.force),
      ...opt("agent", a.agent),
      "--",
      String(a.id),
    ],
  },
  {
    name: "checkpoint_create",
    title: "Create a checkpoint",
    description:
      "Snapshot the task, Git state, recent receipts, and next step for the next agent. Use at meaningful boundaries: before stopping or handing off, after a decision, or after an approach fails. Never include transcripts, secrets, or customer data.",
    inputSchema: object({
      task: text("task id (default: your active task)", 200),
      done: list("things finished"),
      failed_approaches: pair("approach", "why_failed", "approaches that did not work"),
      open_questions: list("open questions"),
      next: text("the next safe action"),
      receipts: list("receipt ids to attach in addition to recent ones", text("", 200)),
      links: list("related record ids", text("", 200)),
      summary: text("one-line summary", 280),
      agent: AGENT,
    }),
    annotations: WRITE,
    argv: async (a) => [
      "checkpoint",
      "create",
      "--json",
      ...opt("task", a.task),
      ...many("done", a.done),
      ...pairs("failed", a.failed_approaches, "approach", "why_failed"),
      ...many("question", a.open_questions),
      ...opt("next", a.next),
      ...many("receipt", a.receipts),
      ...many("link", a.links),
      ...opt("summary", a.summary),
      ...opt("agent", a.agent),
    ],
  },
  {
    name: "receipt_record",
    title: "Record a check result",
    description:
      "Record the result of a command that already ran (tests, lint, build). Alethic does not run it. The output tail is redacted and truncated; the confidence is agent-reported.",
    inputSchema: object(
      {
        command: text("the command that ran, e.g. pnpm test auth", 1000),
        exit_code: { type: "integer", minimum: 0, maximum: 255 },
        result: { type: "string", enum: ["pass", "fail", "error"] },
        output: { type: "string", maxLength: 1_000_000, description: "command output" },
        duration_ms: { type: "integer", minimum: 0 },
        summary: text("one-line summary", 280),
        paths: PATHS,
        agent: AGENT,
      },
      ["command", "exit_code"],
    ),
    annotations: WRITE,
    argv: async (a, scratchDir) => {
      let outputFile: string[] = [];
      if (typeof a.output === "string") {
        const file = path.join(await scratchDir(), "output.txt");
        await writeFile(file, a.output, "utf8");
        outputFile = [`--output-file=${file}`];
      }
      return [
        "receipt",
        "add",
        "--json",
        `--command=${String(a.command)}`,
        `--exit-code=${String(a.exit_code)}`,
        ...opt("result", a.result),
        ...outputFile,
        ...opt("duration-ms", a.duration_ms),
        ...opt("summary", a.summary),
        ...many("paths", a.paths),
        ...opt("agent", a.agent),
      ];
    },
  },
  {
    name: "decision_add",
    title: "Record a decision",
    description:
      "Record what was chosen, why, and which alternatives were rejected. Confidence is agent-reported; a human confirms decisions through the CLI, not through this tool.",
    inputSchema: object(
      {
        topic: text("dotted key for what is decided, e.g. auth.session-invalidation", 200),
        chosen: text("what was chosen"),
        rationale: text("why it was chosen"),
        summary: text("one-line summary", 280),
        alternatives: pair("option", "rejected_because", "rejected alternatives"),
        status: { type: "string", enum: ["proposed", "accepted", "superseded"] },
        paths: PATHS,
        links: list("related record ids", text("", 200)),
        supersedes: list("decision ids this one replaces", text("", 200)),
        evidence_files: list("files that support the decision", text("", 512)),
        checks: list("commands that verify the decision", text("", 1000)),
        id: text("record id", 200),
        agent: AGENT,
      },
      ["topic", "chosen", "rationale"],
    ),
    annotations: WRITE,
    argv: async (a) => [
      "decision",
      "add",
      "--json",
      `--topic=${String(a.topic)}`,
      `--chosen=${String(a.chosen)}`,
      `--rationale=${String(a.rationale)}`,
      ...opt("summary", a.summary),
      ...pairs("alternative", a.alternatives, "option", "rejected_because"),
      ...opt("status", a.status),
      ...many("paths", a.paths),
      ...many("link", a.links),
      ...many("supersedes", a.supersedes),
      ...many("evidence-file", a.evidence_files),
      ...many("check", a.checks),
      ...opt("id", a.id),
      ...opt("agent", a.agent),
    ],
  },
  {
    name: "knowledge_add",
    title: "Record a durable fact",
    description:
      "Record an architectural, operational, convention, or gotcha fact that later agents should know.",
    inputSchema: object(
      {
        category: { type: "string", enum: ["architecture", "operations", "convention", "gotcha"] },
        body: text("the fact, with enough detail to act on"),
        summary: text("one-line summary", 280),
        paths: PATHS,
        links: list("related record ids", text("", 200)),
        evidence_files: list("files that support the fact", text("", 512)),
        id: text("record id", 200),
        agent: AGENT,
      },
      ["category", "body"],
    ),
    annotations: WRITE,
    argv: async (a) => [
      "knowledge",
      "add",
      "--json",
      `--category=${String(a.category)}`,
      `--body=${String(a.body)}`,
      ...opt("summary", a.summary),
      ...many("paths", a.paths),
      ...many("link", a.links),
      ...many("evidence-file", a.evidence_files),
      ...opt("id", a.id),
      ...opt("agent", a.agent),
    ],
  },
];
