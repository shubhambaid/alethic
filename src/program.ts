import path from "node:path";
import { type Command, CommanderError, Command as CommanderProgram } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  checkpointCreateCommand,
  checkpointListCommand,
  checkpointShowCommand,
} from "./commands/checkpoint.js";
import type { Io } from "./commands/context.js";
import { decisionAddCommand, decisionUpdateCommand } from "./commands/decision.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { knowledgeAddCommand, knowledgeUpdateCommand } from "./commands/knowledge.js";
import { mcpCommand } from "./commands/mcp.js";
import { receiptAddCommand, receiptRunCommand } from "./commands/receipt.js";
import { renderCommand } from "./commands/render.js";
import { resumeCommand } from "./commands/resume.js";
import { sessionNewCommand } from "./commands/session.js";
import { showCommand } from "./commands/show.js";
import { statusCommand } from "./commands/status.js";
import {
  taskClaimCommand,
  taskCloseCommand,
  taskStartCommand,
  taskUpdateCommand,
} from "./commands/task.js";
import { validateCommand } from "./commands/validate.js";
import { verifyCommand } from "./commands/verify.js";
import { UsageError } from "./core/errors.js";
import { GitError } from "./git/git.js";

const AGENT_HELP = "agent writing the record (default: $ALETHIC_AGENT)";
const JSON_HELP = "print a machine-readable result";
const FINGERPRINT_HELP = "override limits.max_fingerprints_per_record for this record";

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function withWriteOptions(command: Command): Command {
  return command
    .option("--agent <name>", AGENT_HELP)
    .option("--max-fingerprints <n>", FINGERPRINT_HELP)
    .option("--json", JSON_HELP);
}

function withEvidenceOptions(command: Command): Command {
  return command
    .option("--evidence-file <path>", "file that supports the record (repeatable)", collect, [])
    .option("--commit <sha>", "commit that supports the record (repeatable)", collect, [])
    .option("--check <command>", "check that verifies the record (repeatable)", collect, [])
    .option("--receipt <id>", "receipt that supports the record (repeatable)", collect, [])
    .option("--issue <ref>", "related issue (repeatable)", collect, [])
    .option("--pr <ref>", "related pull request (repeatable)", collect, []);
}

/**
 * Runs the Alethic CLI and resolves to its exit code:
 * 0 success, 1 validation errors, 2 usage or environment problems.
 */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  let exitCode = 0;
  const program = new CommanderProgram()
    .name("alethic")
    .description("Verifiable context for coding agents.")
    .version(pkg.version, "-v, --version")
    .option("-C, --cwd <dir>", "run as if Alethic was started in <dir>")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    });

  const ioFor = (command: Command): Io => {
    const { cwd } = command.optsWithGlobals<{ cwd?: string }>();
    return cwd ? { ...io, cwd: path.resolve(io.cwd, cwd) } : io;
  };

  program
    .command("init")
    .description("Create .alethic/ in the current Git repository")
    .option("--name <name>", "project name (default: the repository directory name)")
    .action(async (options, command: Command) => {
      exitCode = await initCommand(ioFor(command), options);
    });

  program
    .command("validate")
    .description("Check records for schema, provenance, privacy, and lease problems")
    .option("--json", "print a machine-readable report")
    .option("--strict", "treat missing evidence commits as errors")
    .action(async (options, command: Command) => {
      exitCode = await validateCommand(ioFor(command), options);
    });

  program
    .command("status")
    .description("Show Git state, active tasks, and validation summary")
    .option("--json", "print machine-readable status")
    .option("--all-branches", "also list work on other local branches and worktrees")
    .action(async (options, command: Command) => {
      exitCode = await statusCommand(ioFor(command), options);
    });

  program
    .command("session")
    .description("Identify agent sessions")
    .command("new")
    .description(
      "Print a fresh id for ALETHIC_SESSION: export ALETHIC_SESSION=$(alethic session new)",
    )
    .option("--agent <name>", "prefix the id with this agent name (default: $ALETHIC_AGENT)")
    .action(async (options, command: Command) => {
      exitCode = await sessionNewCommand(ioFor(command), options);
    });

  const task = program.command("task").description("Start, claim, update, and close tasks");

  withWriteOptions(
    task
      .command("start")
      .description("Create an active task owned by the current agent")
      .argument("<intent>", "what should be true when the task is done, and why")
      .option("--summary <text>", "one-line summary (default: the intent)")
      .option("--paths <globs...>", "repository paths or globs the task is about")
      .option("--branch <name>", "branch where the work happens (default: the current branch)")
      .option("--next <text>", "the next concrete step")
      .option("--human <name>", "a named human confirmed the intent (human-confirmed)")
      .option("--id <id>", "record id (default: derived from the summary)"),
  ).action(async (intent: string, options, command: Command) => {
    exitCode = await taskStartCommand(ioFor(command), intent, options);
  });

  task
    .command("claim")
    .description("Take ownership of a task, or renew your lease on it")
    .argument("<id>", "task id")
    .option("--force", "take over a task whose lease another agent still holds")
    .option("--agent <name>", AGENT_HELP)
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await taskClaimCommand(ioFor(command), id, options);
    });

  task
    .command("update")
    .description("Pause, block, or re-describe an open task")
    .argument("<id>", "task id")
    .option("--status <status>", "proposed, paused, or blocked")
    .option("--next <text>", "the next concrete step")
    .option("--summary <text>", "new one-line summary")
    .option("--force", "update a task whose lease another agent holds")
    .option("--agent <name>", AGENT_HELP)
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await taskUpdateCommand(ioFor(command), id, options);
    });

  task
    .command("close")
    .description("Close a task after checking its records are valid")
    .argument("<id>", "task id")
    .option("--status <status>", "done or abandoned (default: done)")
    .option("--summary <text>", "final one-line summary")
    .option("--force", "close a task whose lease another agent holds")
    .option("--agent <name>", AGENT_HELP)
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await taskCloseCommand(ioFor(command), id, options);
    });

  const decision = program.command("decision").description("Record and update decisions");

  withWriteOptions(
    withEvidenceOptions(
      decision
        .command("add")
        .description("Record what was chosen, why, and what was rejected")
        .option(
          "--topic <key>",
          "dotted key for what is decided, e.g. auth.session-invalidation (required)",
        )
        .option("--chosen <text>", "what was chosen (required)")
        .option("--rationale <text>", "why it was chosen (required)")
        .option(
          "--from-file <path>",
          "read fields from a YAML or JSON file, or - for stdin; flags add to or override it",
        )
        .option("--summary <text>", "one-line summary (default: the chosen option)")
        .option(
          "--alternative <option::reason>",
          "a rejected alternative (repeatable)",
          collect,
          [],
        )
        .option("--status <status>", "proposed, accepted, or superseded (default: accepted)")
        .option("--paths <globs...>", "repository paths or globs the decision applies to")
        .option("--link <id>", "related record (repeatable)", collect, [])
        .option("--supersedes <id>", "decision this one replaces (repeatable)", collect, [])
        .option("--human <name>", "a named human confirmed the decision (human-confirmed)")
        .option("--id <id>", "record id (default: derived from the topic)"),
    ),
  ).action(async (options, command: Command) => {
    exitCode = await decisionAddCommand(ioFor(command), options);
  });

  decision
    .command("update")
    .description("Change a decision's status or summary")
    .argument("<id>", "decision id")
    .option("--status <status>", "proposed, accepted, or superseded")
    .option("--summary <text>", "new one-line summary")
    .option("--agent <name>", AGENT_HELP)
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await decisionUpdateCommand(ioFor(command), id, options);
    });

  const knowledge = program.command("knowledge").description("Record and update durable facts");

  withWriteOptions(
    withEvidenceOptions(
      knowledge
        .command("add")
        .description("Record an architectural or operational fact")
        .option(
          "--category <category>",
          "architecture, operations, convention, or gotcha (required)",
        )
        .option("--body <text>", "the fact, with enough detail to act on (required)")
        .option(
          "--from-file <path>",
          "read fields from a YAML or JSON file, or - for stdin; flags add to or override it",
        )
        .option("--summary <text>", "one-line summary (default: the body)")
        .option("--paths <globs...>", "repository paths or globs the fact is about")
        .option("--link <id>", "related record (repeatable)", collect, [])
        .option("--human <name>", "a named human confirmed the fact (human-confirmed)")
        .option("--id <id>", "record id (default: derived from the summary)"),
    ),
  ).action(async (options, command: Command) => {
    exitCode = await knowledgeAddCommand(ioFor(command), options);
  });

  knowledge
    .command("update")
    .description("Change a knowledge record's status or summary")
    .argument("<id>", "knowledge id")
    .option("--status <status>", "active or deprecated")
    .option("--summary <text>", "new one-line summary")
    .option("--agent <name>", AGENT_HELP)
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await knowledgeUpdateCommand(ioFor(command), id, options);
    });

  const receipt = program.command("receipt").description("Record verification results");

  withWriteOptions(
    receipt
      .command("add")
      .description("Record the result of a check that already ran (Alethic does not run it)")
      .requiredOption("--command <command>", "the command that ran, e.g. 'pnpm test auth'")
      .requiredOption("--exit-code <n>", "its exit code")
      .option("--result <result>", "pass, fail, or error (default: from the exit code)")
      .option(
        "--output-file <path>",
        "output to keep the redacted tail of (at most 4000 characters)",
      )
      .option("--duration-ms <n>", "how long it ran")
      .option("--ran-at <timestamp>", "when it ran, UTC (default: now)")
      .option("--summary <text>", "one-line summary")
      .option("--paths <globs...>", "repository paths the check covers")
      .option("--id <id>", "record id (default: derived from the command)"),
  ).action(async (options, command: Command) => {
    exitCode = await receiptAddCommand(ioFor(command), options);
  });

  withWriteOptions(
    receipt
      .command("run")
      .description(
        "Run a check and record what it did and the code it ran on (exit 1 if the check fails)",
      )
      .argument("<command...>", "the command and its arguments, after --")
      .option("--summary <text>", "one-line summary")
      .option(
        "--paths <globs...>",
        "only digest files matching these paths (default: the whole working tree)",
      )
      .option("--id <id>", "record id (default: derived from the command)"),
  ).action(async (argv: string[], options, command: Command) => {
    exitCode = await receiptRunCommand(ioFor(command), argv, options);
  });

  const checkpoint = program
    .command("checkpoint")
    .description("Write and read handoff snapshots for unfinished work");

  withWriteOptions(
    checkpoint
      .command("create")
      .description("Snapshot the task, Git state, evidence, and next step for the next agent")
      .option("--task <id>", "task id (default: your active task)")
      .option("--done <text>", "something finished (repeatable)", collect, [])
      .option("--failed <approach::why>", "an approach that did not work (repeatable)", collect, [])
      .option("--question <text>", "an open question (repeatable)", collect, [])
      .option("--next <text>", "next safe action (default: the task's next action)")
      .option(
        "--receipt <id>",
        "receipt to attach, in addition to your recent ones (repeatable)",
        collect,
        [],
      )
      .option("--link <id>", "related record (repeatable)", collect, [])
      .option("--summary <text>", "one-line summary")
      .option("--human <name>", "a named human reviewed the checkpoint (human-confirmed)")
      .option("--id <id>", "record id (default: derived from the task and time)")
      .option(
        "--from-file <path>",
        "read fields from a YAML or JSON file, or - for stdin; flags add to or override it",
      ),
  ).action(async (options, command: Command) => {
    exitCode = await checkpointCreateCommand(ioFor(command), options);
  });

  checkpoint
    .command("list")
    .description("List checkpoints, newest first")
    .option("--task <id>", "only checkpoints for this task")
    .option("--json", JSON_HELP)
    .action(async (options, command: Command) => {
      exitCode = await checkpointListCommand(ioFor(command), options);
    });

  checkpoint
    .command("show")
    .description("Show a checkpoint with its task and receipts")
    .argument("<id>", "checkpoint id")
    .option("--json", JSON_HELP)
    .action(async (id: string, options, command: Command) => {
      exitCode = await checkpointShowCommand(ioFor(command), id, options);
    });

  program
    .command("resume")
    .description("Compile a cited, budgeted briefing for continuing a task")
    .option("--task <id>", "task to brief (default: your active task, or the only open task)")
    .option("--target <agent>", "codex, claude-code, gemini, or generic (default: generic)")
    .option(
      "--budget <tokens>",
      "approximate size in tokens, estimated as characters / 4 (default: defaults.budget)",
    )
    .option("--format <format>", "md or json (default: md)")
    .option("--agent <name>", "agent reading the briefing, to find its active task")
    .option("--no-concurrent", "leave out work on other branches and worktrees")
    .action(async (options, command: Command) => {
      exitCode = await resumeCommand(ioFor(command), options);
    });

  program
    .command("show")
    .description(
      "Show one record with its derived freshness and trust, such as an item a briefing collapsed",
    )
    .argument("<id>", "record id")
    .option("--json", JSON_HELP)
    .option("--ref <branch>", "read the record from another local branch or worktree path")
    .action(async (id: string, options, command: Command) => {
      exitCode = await showCommand(ioFor(command), id, options);
    });

  program
    .command("dashboard")
    .description("Serve a read-only local dashboard of sessions, records, handoffs, and health")
    .option("--port <n>", "port to listen on (default: 4700; 0 picks a free port)")
    .option("--host <address>", "loopback address: 127.0.0.1 (default), ::1, or localhost")
    .option("--snapshot <file>", "write the dashboard's data as JSON (- for stdout) and exit")
    .action(async (options, command: Command) => {
      const { dashboardCommand } = await import("./commands/dashboard.js");
      exitCode = await dashboardCommand(ioFor(command), options);
    });

  withWriteOptions(
    program
      .command("verify")
      .description(
        "Re-anchor a decision, knowledge record, or task to HEAD after checking it holds",
      )
      .argument("<id>", "record id")
      .option("--human <name>", "a named human confirmed it against the current code")
      .option("--note <text>", "with --human: what the person checked")
      .option("--receipt <id>", "receipt that supports it (repeatable)", collect, []),
  ).action(async (id: string, options, command: Command) => {
    exitCode = await verifyCommand(ioFor(command), id, options);
  });

  program
    .command("doctor")
    .description("Find stale records, conflicts, and lease problems, with a command to fix each")
    .option(
      "--fix",
      "apply safe fixes: pause tasks with expired leases, retire superseded decisions",
    )
    .option("--strict", "treat missing evidence commits as errors")
    .option("--agent <name>", "agent applying --fix (default: $ALETHIC_AGENT)")
    .option("--json", "print a machine-readable report")
    .action(async (options, command: Command) => {
      exitCode = await doctorCommand(ioFor(command), options);
    });

  program
    .command("render")
    .description("Write agent instruction blocks, or print a pull request summary")
    .argument("<output>", "agents-md, claude-md, gemini-md, or pr-summary")
    .option("--write", "update the instruction file (default: preview the block)")
    .option("--check", "exit 1 if the instruction file is missing or out of date")
    .option("--task <id>", "pr-summary: task to summarize (default: your active task)")
    .option("--agent <name>", "pr-summary: agent whose active task to summarize")
    .action(async (output: string, options, command: Command) => {
      exitCode = await renderCommand(ioFor(command), output, options);
    });

  program
    .command("mcp")
    .description("Serve Alethic tools and resources over MCP (stdio)")
    .action(async (_options, command: Command) => {
      // Claude Code tells project servers where the project is; an explicit -C still wins.
      const { cwd } = command.optsWithGlobals<{ cwd?: string }>();
      const projectDir = io.env.CLAUDE_PROJECT_DIR;
      exitCode = await mcpCommand(
        !cwd && projectDir ? { ...io, cwd: projectDir } : ioFor(command),
        runCli,
      );
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    if (error instanceof UsageError || error instanceof GitError) {
      io.stderr(`error: ${error.message}\n`);
      return 2;
    }
    io.stderr(`error: unexpected failure: ${(error as Error).message}\n`);
    if (io.env.ALETHIC_DEBUG) io.stderr(`${(error as Error).stack}\n`);
    return 2;
  }
}
