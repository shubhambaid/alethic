import path from "node:path";
import { UsageError } from "../core/errors.js";
import type { Finding } from "../core/findings.js";
import { isRecordKind, KIND_DIRS, type RecordKind } from "../core/ids.js";
import { asString } from "../core/json.js";
import { loadManifest, MANIFEST_FILE, type Manifest, resolveManifest } from "../core/manifest.js";
import { checkRepoPath, isGlob, scopeMatcher } from "../core/paths.js";
import { type LoadedRecord, loadRecords, type StoreLoad } from "../core/store.js";
import { confirmationState } from "../trust/claims.js";
import { collectPaths, collectReferences } from "./references.js";
import { validateAgainst } from "./schema.js";
import { compileSecretPatterns, type SecretPattern, scanForSecrets } from "./secrets.js";

const SPEC_SECTION: Record<RecordKind, string> = {
  task: "§6.1",
  decision: "§6.2",
  knowledge: "§6.3",
  checkpoint: "§6.4",
  receipt: "§6.5",
};

/**
 * Finding codes that make a record unusable in shared outputs (briefings, PR summaries, record
 * views): its shape, identity, trust label, or privacy cannot be relied on. Other findings, such
 * as an expired lease or a dangling link, are reported but leave the record's own content usable.
 */
export const EXCLUDING_CODES: ReadonlySet<string> = new Set([
  "schema",
  "id-mismatch",
  "kind-mismatch",
  "duplicate-id",
  "secret",
  "untrusted-confidence",
  "forbidden-path",
]);

export interface ExcludedRecord {
  file: string;
  kind: RecordKind;
  /** Undefined when the id itself is missing, malformed, or looks like a secret. */
  id?: string;
  /** Excluding finding codes, sorted and unique. */
  codes: string[];
}

/** Everything that can be checked about the ledger without Git history or the filesystem. */
export interface LedgerAssessment {
  root: string;
  /** Undefined when the manifest is missing or invalid. */
  manifest?: Manifest;
  /** The manifest, or defaults when it is invalid, so checks can still run. */
  settings: Manifest;
  secretPatterns: SecretPattern[];
  /** Every record file that parsed, usable or not. */
  records: LoadedRecord[];
  /** Manifest, loading, and record-level findings. Unsorted. */
  findings: Finding[];
  /** Usable records by id. Ids here are unique. */
  index: Map<string, LoadedRecord>;
  /** Records withheld from shared outputs, in file order. */
  excluded: ExcludedRecord[];
  /** Files under .alethic/ that could not be loaded as records (errors only). */
  unloadable: string[];
}

export const FALLBACK_MANIFEST = resolveManifest({ project: { name: "unknown" } });

/**
 * The shared read path (docs/spec.md §14, §16). `validate` adds Git- and filesystem-based checks
 * on top; `resume`, record views, and the dashboard use only records that pass these checks.
 */
export async function assessLedger(root: string): Promise<LedgerAssessment> {
  const manifestLoad = await loadManifest(root);
  const settings = manifestLoad.manifest ?? FALLBACK_MANIFEST;
  const store = await loadRecords(root);
  const secrets = compileSecretPatterns(settings.privacy.extra_secret_patterns);
  const assessed = assessRecords(store, settings, secrets.patterns);

  return {
    root,
    ...(manifestLoad.manifest ? { manifest: manifestLoad.manifest } : {}),
    settings,
    secretPatterns: secrets.patterns,
    records: store.records,
    findings: [
      ...manifestLoad.findings,
      ...store.findings,
      ...secrets.invalid.map(
        ({ pattern, error }): Finding => ({
          severity: "error",
          code: "manifest-pattern",
          file: MANIFEST_FILE,
          path: `privacy.extra_secret_patterns[${settings.privacy.extra_secret_patterns.indexOf(pattern)}]`,
          message: `Invalid regular expression: ${error}`,
        }),
      ),
      ...assessed.recordFindings,
    ],
    index: assessed.index,
    excluded: assessed.excluded,
    unloadable: assessed.unloadable,
  };
}

/** The result of the shared record checks, independent of where the records were read from. */
export interface RecordAssessment {
  /** Record-level findings, unsorted. Loading findings stay in the store load. */
  recordFindings: Finding[];
  /** Usable records by id. Ids here are unique. */
  index: Map<string, LoadedRecord>;
  /** Records withheld from shared outputs, in file order. */
  excluded: ExcludedRecord[];
  /** Files that could not be loaded as records (errors only). */
  unloadable: string[];
}

/**
 * The checks every record passes before any output uses it, without Git or the filesystem.
 * Records read from another branch or worktree go through this too, with this checkout's
 * privacy settings, so a branch cannot weaken the rules that apply to what is shown here.
 */
export function assessRecords(
  store: StoreLoad,
  settings: Manifest,
  secretPatterns: SecretPattern[],
): RecordAssessment {
  const { records } = store;
  const recordFindings = [
    ...checkSchemas(records),
    ...checkIdentity(records),
    ...checkReferences(records),
    ...checkSecrets(records, secretPatterns),
    ...checkTrust(records, settings),
    ...checkForbiddenPaths(records, settings),
    ...checkConfirmations(records),
  ];

  const excludingByFile = new Map<string, Set<string>>();
  const idIsSensitive = new Set<string>();
  for (const finding of recordFindings) {
    if (!finding.file || !EXCLUDING_CODES.has(finding.code)) continue;
    const codes = excludingByFile.get(finding.file) ?? new Set<string>();
    codes.add(finding.code);
    excludingByFile.set(finding.file, codes);
    if (finding.code === "secret" && finding.path === "id") idIsSensitive.add(finding.file);
  }

  const index = new Map<string, LoadedRecord>();
  const excluded: ExcludedRecord[] = [];
  for (const record of records) {
    const codes = excludingByFile.get(record.file);
    const id = asString(record.data.id);
    if (codes) {
      const safeId =
        id !== undefined && !idIsSensitive.has(record.file) && !codes.has("schema")
          ? id
          : undefined;
      excluded.push({
        file: record.file,
        kind: record.kind,
        ...(safeId ? { id: safeId } : {}),
        codes: [...codes].sort(),
      });
      continue;
    }
    if (id !== undefined) index.set(id, record);
  }

  return {
    recordFindings,
    index,
    excluded: excluded.sort((a, b) => a.file.localeCompare(b.file)),
    unloadable: [
      ...new Set(
        store.findings.filter((f) => f.severity === "error" && f.file).map((f) => f.file as string),
      ),
    ].sort(),
  };
}

/** Like `requireRecord`, but explains when the record exists and failed validation. */
export function requireUsable(
  ledger: Pick<LedgerAssessment, "index" | "excluded">,
  id: string,
  kind?: RecordKind,
  label?: string,
): LoadedRecord {
  const prefix = label ? `${label} ` : "";
  const record = ledger.index.get(id);
  if (!record) {
    const failed = ledger.excluded.filter((entry) => entry.id === id);
    if (failed.length > 0) {
      const codes = [...new Set(failed.flatMap((entry) => entry.codes))].sort().join(", ");
      throw new UsageError(
        `${prefix}${id} failed validation (${codes}), so its content is not used. Run \`alethic validate\` and fix ${failed.map((entry) => entry.file).join(", ")}.`,
      );
    }
    throw new UsageError(`${prefix}${id} does not exist`);
  }
  if (kind && record.kind !== kind) {
    throw new UsageError(`${prefix}${id} is a ${record.kind}, not a ${kind}`);
  }
  return record;
}

/** The manifest, or a usage error listing why it is invalid. */
export function requireManifest(ledger: LedgerAssessment): Manifest {
  if (ledger.manifest) return ledger.manifest;
  const problems = ledger.findings
    .filter((f) => f.file === MANIFEST_FILE)
    .map((f) => `${f.path ?? f.file}: ${f.message}`)
    .join("; ");
  throw new UsageError(`The manifest is invalid (${problems}). Run \`alethic validate\`.`);
}

function checkSchemas(records: readonly LoadedRecord[]): Finding[] {
  return records.flatMap((record) =>
    validateAgainst(record.kind, record.data).issues.map(
      (issue): Finding => ({
        severity: "error",
        code: "schema",
        file: record.file,
        path: issue.path,
        message: issue.message,
        hint: `See docs/spec.md ${SPEC_SECTION[record.kind]}.`,
      }),
    ),
  );
}

function checkIdentity(records: readonly LoadedRecord[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map<string, LoadedRecord[]>();

  for (const record of records) {
    const id = asString(record.data.id);
    const stem = path.posix.basename(record.file, ".yaml");
    if (id !== undefined && id !== stem) {
      findings.push({
        severity: "error",
        code: "id-mismatch",
        file: record.file,
        path: "id",
        message: `id "${id}" does not match the file name ${stem}.yaml`,
        hint: `Rename the file to ${id}.yaml, or change the id.`,
      });
    }
    const kind = asString(record.data.kind);
    if (kind !== undefined && kind !== record.kind && isRecordKind(kind)) {
      findings.push({
        severity: "error",
        code: "kind-mismatch",
        file: record.file,
        path: "kind",
        message: `A ${kind} record is stored in ${KIND_DIRS[record.kind]}/`,
        hint: `Move it to .alethic/${KIND_DIRS[kind]}/.`,
      });
    }
    if (id) byId.set(id, [...(byId.get(id) ?? []), record]);
  }

  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const record of group) {
      const others = group.filter((other) => other !== record).map((other) => other.file);
      findings.push({
        severity: "error",
        code: "duplicate-id",
        file: record.file,
        path: "id",
        message: `id "${id}" is also used by ${others.join(", ")}`,
        hint: "Give each record a unique id.",
      });
    }
  }
  return findings;
}

function checkReferences(records: readonly LoadedRecord[]): Finding[] {
  const byId = new Map<string, LoadedRecord>();
  for (const record of records) {
    const id = asString(record.data.id);
    if (id !== undefined && !byId.has(id)) byId.set(id, record);
  }

  return records.flatMap((record) =>
    collectReferences(record.data).flatMap((ref): Finding[] => {
      const target = byId.get(ref.id);
      if (!target) {
        return [
          {
            severity: "error",
            code: "dangling-reference",
            file: record.file,
            path: ref.path,
            message: `${ref.id} does not exist`,
            hint: "Create the referenced record, or remove the reference.",
          },
        ];
      }
      const expected = ref.sameKind ? record.kind : ref.expected;
      if (expected && target.kind !== expected) {
        return [
          {
            severity: "error",
            code: "wrong-reference-kind",
            file: record.file,
            path: ref.path,
            message: `${ref.id} is a ${target.kind}, but a ${expected} is expected here`,
          },
        ];
      }
      return [];
    }),
  );
}

function checkSecrets(records: readonly LoadedRecord[], patterns: SecretPattern[]): Finding[] {
  return records.flatMap((record) =>
    scanForSecrets(record.data, patterns).map(
      (secret): Finding => ({
        severity: "error",
        code: "secret",
        file: record.file,
        path: secret.path,
        message: `Looks like a ${secret.pattern}`,
        hint: "Remove it. Records are shared and permanent; never store credentials (docs/spec.md §13).",
      }),
    ),
  );
}

function checkTrust(records: readonly LoadedRecord[], manifest: Manifest): Finding[] {
  return records
    .filter((record) => record.data.confidence === "ci-verified")
    .map(
      (record): Finding => ({
        severity: "error",
        code: "untrusted-confidence",
        file: record.file,
        path: "confidence",
        message:
          manifest.trust.ci_provenance === "none"
            ? "ci-verified requires trusted CI provenance, but trust.ci_provenance is none"
            : "ci-verified cannot be checked yet: provenance verification is not available in this version",
        hint: "Use ci-reported for CI self-reports, or agent-reported (docs/spec.md §8).",
      }),
    );
}

/** Human confirmations whose claim was edited afterwards (docs/spec.md §8). Not excluding. */
function checkConfirmations(records: readonly LoadedRecord[]): Finding[] {
  return records.flatMap((record): Finding[] => {
    const state = confirmationState(record.kind, record.data);
    if (state.level !== "outdated") return [];
    const id = asString(record.data.id) ?? record.file;
    const who = state.name ?? "the person";
    return [
      {
        severity: "warning",
        code: "confirmation-outdated",
        file: record.file,
        path: "confidence",
        message: `The claim was edited after ${who} confirmed it, so that confirmation no longer applies`,
        hint: `Ask ${who} to check the current text, then run \`alethic verify ${id} --human <name>\`; until then it counts as agent-reported.`,
      },
    ];
  });
}

/** Paths matching `privacy.forbidden_globs`. Lexically unsafe paths are reported by the schema. */
function checkForbiddenPaths(records: readonly LoadedRecord[], manifest: Manifest): Finding[] {
  const forbidden = scopeMatcher(manifest.privacy.forbidden_globs);
  const findings: Finding[] = [];
  for (const record of records) {
    for (const field of collectPaths(record.data)) {
      if (checkRepoPath(field.value) !== undefined || isGlob(field.value)) continue;
      if (!forbidden(field.value)) continue;
      findings.push({
        severity: "error",
        code: "forbidden-path",
        file: record.file,
        path: field.path,
        message: `${field.value} matches privacy.forbidden_globs`,
        hint: "Records must not cite or fingerprint forbidden paths. Remove the reference.",
      });
    }
  }
  return findings;
}
