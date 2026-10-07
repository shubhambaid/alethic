import { UsageError } from "../core/errors.js";
import { isRecordKind, RECORD_KINDS, type RecordKind } from "../core/ids.js";
import { asString } from "../core/json.js";
import { resolveEmbedder } from "../search/embedding.js";
import { search } from "../search/rank.js";
import { documentOf, type SearchDocument } from "../search/text.js";
import { confirmationState } from "../trust/claims.js";
import { assessStaleness, createStalenessContext } from "../trust/staleness.js";
import { assessLedger, requireManifest } from "../validate/assess.js";
import { type Io, requireInitialized } from "./context.js";
import { plural } from "./output.js";

export interface SearchCommandOptions {
  kind?: string[];
  limit?: string;
  /** `--semantic` is true, `--no-semantic` is false, and unset follows the manifest. */
  semantic?: boolean;
  json?: boolean;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

function parseKinds(values: readonly string[] | undefined): Set<RecordKind> | undefined {
  if (!values || values.length === 0) return undefined;
  const kinds = new Set<RecordKind>();
  for (const value of values) {
    if (!isRecordKind(value)) {
      throw new UsageError(`--kind must be one of ${RECORD_KINDS.join(", ")}, not ${value}`);
    }
    kinds.add(value);
  }
  return kinds;
}

/**
 * Find records by words, and optionally by meaning. It answers "did anyone already decide, learn,
 * or try this?" for work that shares no path or link with the records, which is where `resume`'s
 * deterministic retrieval is blind by design. Only records that pass the shared assessment are
 * searched, results carry the same freshness and trust labels as `show`, and nothing here writes.
 */
export async function searchCommand(
  io: Io,
  query: string,
  options: SearchCommandOptions,
): Promise<number> {
  const root = await requireInitialized(io);
  if (query.trim() === "") throw new UsageError("search needs a non-empty query");
  const limit = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new UsageError(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const kinds = parseKinds(options.kind);

  const ledger = await assessLedger(root);
  const manifest = requireManifest(ledger);
  const documents = [...ledger.index.values()]
    .filter((record) => !kinds || kinds.has(record.kind))
    .map(documentOf)
    .filter((doc): doc is SearchDocument => doc !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const withheld = ledger.excluded.filter((entry) => !kinds || kinds.has(entry.kind)).length;

  const wantsSemantic = options.semantic ?? manifest.search.semantic;
  let embedder: Awaited<ReturnType<typeof resolveEmbedder>> | undefined;
  if (wantsSemantic) {
    try {
      embedder = await resolveEmbedder(manifest.search, io.env, io.cwd);
    } catch (error) {
      // An explicit --semantic must not quietly become keyword search; a manifest default may.
      if (options.semantic === true || !(error instanceof UsageError)) throw error;
      io.stderr(`note: ${error.message}\nnote: searching by keywords only\n`);
    }
  }

  const outcome = await search({
    query,
    documents,
    limit,
    ...(embedder ? { semantic: { root, embedder, model: manifest.search.model } } : {}),
  });

  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const staleness = await createStalenessContext(root, manifest);
  const results = [];
  for (const hit of outcome.hits) {
    const doc = byId.get(hit.id) as SearchDocument;
    const { record } = doc;
    const freshness = await assessStaleness(staleness, record.data);
    const confirmation = confirmationState(record.kind, record.data);
    results.push({
      id: doc.id,
      kind: record.kind,
      status: asString(record.data.status) ?? "unknown",
      file: record.file,
      summary: doc.title,
      matched: [...(hit.keywordRank ? ["keywords"] : []), ...(hit.meaningRank ? ["meaning"] : [])],
      score: Number(hit.score.toFixed(5)),
      ...(hit.keywordRank ? { keywordRank: hit.keywordRank } : {}),
      ...(hit.meaningRank ? { meaningRank: hit.meaningRank } : {}),
      ...(hit.similarity === undefined ? {} : { similarity: Number(hit.similarity.toFixed(4)) }),
      freshness: freshness.status,
      confidence:
        confirmation.level === "none"
          ? (asString(record.data.confidence) ?? "unknown")
          : "human-confirmed (attributed; not authenticated)",
    });
  }

  const mode = embedder ? "keywords and meaning" : "keywords";
  if (options.json) {
    io.stdout(
      `${JSON.stringify({ query, mode: embedder ? "hybrid" : "keyword", ...(embedder ? { embedder: embedder.id } : {}), searched: documents.length, withheld, results }, null, 2)}\n`,
    );
    return 0;
  }

  const lines = [
    `Search: ${JSON.stringify(query)} (${mode}; ${plural(documents.length, "record")} searched)`,
    "",
  ];
  if (results.length === 0) lines.push("No matching records.");
  results.forEach((result, i) => {
    const similarity = result.similarity === undefined ? "" : `, similarity ${result.similarity}`;
    lines.push(
      `${i + 1}. ${result.id} (${result.kind}, ${result.status}) ${result.summary}`,
      `   ${result.confidence} · freshness: ${result.freshness} · matched by ${result.matched.join(" and ")}${similarity}`,
    );
  });
  if (withheld > 0) {
    lines.push(
      "",
      `${plural(withheld, "record")} failed validation and ${withheld === 1 ? "was" : "were"} not searched. Run \`alethic validate\`.`,
    );
  }
  if (results.length > 0) lines.push("", "Read one in full with `alethic show <id>`.");
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}
