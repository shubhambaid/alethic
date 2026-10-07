import { asArray, asObject, asString } from "../core/json.js";
import type { LoadedRecord } from "../core/store.js";

/** What is searched for one record: a short title and the full text. */
export interface SearchDocument {
  id: string;
  record: LoadedRecord;
  title: string;
  body: string;
}

/** Longest document sent to an embedder (EmbeddingGemma has a 2K-token context). */
export const MAX_DOCUMENT_CHARS = 6000;

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function pairsOf(value: unknown, left: string, right: string): string[] {
  return asArray(value).flatMap((item) => {
    const entry = asObject(item);
    const first = asString(entry?.[left]);
    const second = asString(entry?.[right]);
    return first && second ? [`${first}: ${second}`] : [];
  });
}

/**
 * The prose of a record, by kind. Only fields that carry meaning: ids, timestamps, digests, and
 * trust metadata are not searched. Callers pass records that already passed the shared
 * assessment, so nothing here has to repeat the privacy checks.
 */
export function documentOf(record: LoadedRecord): SearchDocument | undefined {
  const { data } = record;
  const id = asString(data.id);
  if (!id) return undefined;
  const title = asString(data.summary) ?? id;
  const parts: (string | undefined)[] = [];
  switch (record.kind) {
    case "task":
      parts.push(asString(data.intent), asString(data.next_action));
      break;
    case "decision":
      parts.push(
        asString(data.topic),
        asString(data.chosen),
        asString(data.rationale),
        ...pairsOf(data.alternatives, "option", "rejected_because").map(
          (line) => `rejected ${line}`,
        ),
      );
      break;
    case "knowledge":
      parts.push(asString(data.category), asString(data.body));
      break;
    case "checkpoint":
      parts.push(
        ...strings(data.done),
        ...pairsOf(data.failed_approaches, "approach", "why_failed").map(
          (line) => `failed approach ${line}`,
        ),
        ...strings(data.open_questions),
        asString(data.next_safe_action),
      );
      break;
    case "receipt":
      parts.push(asString(data.command), asString(data.result));
      break;
  }
  const body = parts.filter((part): part is string => !!part).join("\n");
  return { id, record, title, body: body.slice(0, MAX_DOCUMENT_CHARS) };
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/** Lowercase words, with a trailing plural "s" removed so "sessions" matches "session". */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    let word = match[0];
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    if (word.length > 1) tokens.push(word);
  }
  return tokens;
}
