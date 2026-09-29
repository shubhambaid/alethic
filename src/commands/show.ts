import { digestOf } from "../core/anchor.js";
import { UsageError } from "../core/errors.js";
import { asString } from "../core/json.js";
import { headCommit, isDirty } from "../git/git.js";
import { findSource } from "../git/sources.js";
import { confirmationState } from "../trust/claims.js";
import { assessSource } from "../trust/concurrent.js";
import {
  assessReceipt,
  createReceiptContext,
  describeApplicability,
  type ReceiptAssessment,
} from "../trust/receipts.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import {
  assessLedger,
  type LedgerAssessment,
  requireManifest,
  requireUsable,
} from "../validate/assess.js";
import { type Io, requireInitialized } from "./context.js";
import { formatFinding } from "./output.js";

export interface ShowOptions {
  json?: boolean;
  /** Read the record from another local branch or worktree (spec §12.1). */
  ref?: string;
}

/**
 * One record, with what is derived about it: freshness (spec §9), trust (§8), and for receipts,
 * whether the result applies to the current code (§6.5). It is how an agent reads an item a
 * briefing collapsed into an "N more" pointer. Only records that pass the shared assessment are
 * shown, so a withheld record's content is never printed.
 */
export async function showCommand(io: Io, id: string, options: ShowOptions): Promise<number> {
  const root = await requireInitialized(io);
  const ledger = await assessLedger(root);
  const manifest = requireManifest(ledger);
  if (options.ref !== undefined) return showFromSource(io, root, ledger, id, options.ref, options);
  const record = requireUsable(ledger, id);

  const staleness = await assessStaleness(
    await createStalenessContext(root, manifest),
    record.data,
  );
  const confirmation = confirmationState(record.kind, record.data);
  let receipt: ReceiptAssessment | undefined;
  if (record.kind === "receipt") {
    const [head, dirty] = await Promise.all([headCommit(root), isDirty(root)]);
    receipt = await assessReceipt(
      createReceiptContext(root, manifest, { head, dirty }),
      record.data,
    );
  }
  const findings = ledger.findings.filter((finding) => finding.file === record.file);
  // The Git blob id of the file: the record's revision, the same id `git hash-object` prints.
  const revision = digestOf(record.text);

  if (options.json) {
    const output = {
      id,
      kind: record.kind,
      file: record.file,
      revision,
      record: record.data,
      derived: {
        staleness,
        confirmation,
        ...(receipt ? { receipt } : {}),
      },
      findings,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  const freshness =
    staleness.reasons.length > 0
      ? `${staleness.status}: ${staleness.reasons.join("; ")}`
      : staleness.status;
  const trust =
    confirmation.level === "none"
      ? (asString(record.data.confidence) ?? "unknown")
      : `human-confirmed by ${confirmation.name ?? "?"} (${confirmation.level}${confirmation.recordedBy ? `, recorded by ${confirmation.recordedBy}` : ""}; not authenticated)`;
  const lines = [
    `# ${id} (${record.kind})`,
    "",
    `File:      ${record.file}`,
    `Revision:  ${revision}`,
    `Freshness: ${freshness}`,
    `Trust:     ${trust}`,
    ...(receipt ? [`Applies:   ${describeApplicability(receipt).full}`] : []),
    ...staleness.notes.map((note) => `Note:      ${note}`),
    ...(findings.length > 0 ? ["", ...findings.map(formatFinding)] : []),
    "",
    "---",
    record.text.trimEnd(),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

/**
 * A record from another branch or worktree, as a concurrent-work notice cited it. It passes the
 * same checks, with this checkout's privacy settings. Freshness and receipt applicability are not
 * judged: they describe this checkout's code, and the record describes another line of work.
 */
async function showFromSource(
  io: Io,
  root: string,
  ledger: LedgerAssessment,
  id: string,
  ref: string,
  options: ShowOptions,
): Promise<number> {
  const source = await findSource(root, ref);
  if (!source) {
    throw new UsageError(`--ref ${ref} is not a local branch or a worktree of this repository`);
  }
  const assessed = await assessSource(root, ledger, source);
  const record = requireUsable(assessed, id);
  const confirmation = confirmationState(record.kind, record.data);
  const findings = [...assessed.store.findings, ...assessed.recordFindings].filter(
    (finding) => finding.file === record.file,
  );
  const revision = digestOf(record.text);
  const worktree = source.worktreePath;
  const from = worktree ? `${source.name} (worktree ${worktree})` : source.name;

  if (options.json) {
    const output = {
      id,
      kind: record.kind,
      file: record.file,
      revision,
      source: {
        name: source.name,
        ...(source.branch ? { branch: source.branch } : {}),
        tip: source.tip,
        ...(worktree ? { worktree } : {}),
      },
      record: record.data,
      derived: { confirmation },
      findings,
    };
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }

  const trust =
    confirmation.level === "none"
      ? (asString(record.data.confidence) ?? "unknown")
      : `human-confirmed by ${confirmation.name ?? "?"} (${confirmation.level}${confirmation.recordedBy ? `, recorded by ${confirmation.recordedBy}` : ""}; not authenticated)`;
  const lines = [
    `# ${id} (${record.kind}) on ${source.name}`,
    "",
    `From:      ${from}`,
    `File:      ${record.file}`,
    `Revision:  ${revision}`,
    "Freshness: not judged; this record describes another line of work, not this checkout",
    `Trust:     ${trust}`,
    ...(findings.length > 0 ? ["", ...findings.map(formatFinding)] : []),
    "",
    "---",
    record.text.trimEnd(),
  ];
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
