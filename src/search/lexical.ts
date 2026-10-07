import { type SearchDocument, tokenize } from "./text.js";

export interface Scored {
  id: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

/**
 * BM25 over the documents. The title counts twice, so a record whose summary matches outranks one
 * that mentions the word in passing. Deterministic: ties break by id. Only documents that share
 * at least one term with the query are returned.
 */
export function lexicalRank(documents: readonly SearchDocument[], query: string): Scored[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || documents.length === 0) return [];

  const tokenized = documents.map((doc) => {
    const tokens = [...tokenize(doc.title), ...tokenize(doc.title), ...tokenize(doc.body)];
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { id: doc.id, length: tokens.length, counts };
  });
  const average = tokenized.reduce((sum, doc) => sum + doc.length, 0) / tokenized.length || 1;
  const n = tokenized.length;

  const scored: Scored[] = [];
  for (const doc of tokenized) {
    let score = 0;
    for (const term of terms) {
      const tf = doc.counts.get(term) ?? 0;
      if (tf === 0) continue;
      const df = tokenized.filter((other) => other.counts.has(term)).length;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / average));
    }
    if (score > 0) scored.push({ id: doc.id, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
