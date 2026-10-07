import { cosine, type Embedder, embedDocuments } from "./embedding.js";
import { lexicalRank } from "./lexical.js";
import type { SearchDocument } from "./text.js";

export interface Hit {
  id: string;
  /** Reciprocal-rank-fusion score; only comparable within one search. */
  score: number;
  /** 1-based rank by keywords, when the record shares a term with the query. */
  keywordRank?: number;
  /** 1-based rank by meaning, when semantic search ran. */
  meaningRank?: number;
  /** Cosine similarity to the query, when semantic search ran. */
  similarity?: number;
}

export interface SearchOutcome {
  hits: Hit[];
  /** Documents embedded during this search (0 when every vector was cached). */
  embedded: number;
}

/** The constant from Cormack et al. (2009); damps the head of each list. */
const RRF_K = 60;

export interface SearchOptions {
  query: string;
  documents: readonly SearchDocument[];
  limit: number;
  /** Present for semantic or hybrid search. */
  semantic?: { root: string; embedder: Embedder; model: string };
}

/**
 * Keyword search, or keyword and meaning fused by reciprocal rank. Fusing ranks instead of scores
 * keeps the two scales from needing calibration, and keeps an exact keyword match near the top
 * even when the embedding model has never seen the project's vocabulary. Ties break by id, so the
 * same ledger and query give the same order whenever the embedder does.
 */
export async function search(options: SearchOptions): Promise<SearchOutcome> {
  const { query, documents, limit, semantic } = options;
  const keyword = lexicalRank(documents, query);
  const hits = new Map<string, Hit>();
  const hit = (id: string): Hit => {
    let existing = hits.get(id);
    if (!existing) {
      existing = { id, score: 0 };
      hits.set(id, existing);
    }
    return existing;
  };
  keyword.forEach(({ id }, i) => {
    const entry = hit(id);
    entry.keywordRank = i + 1;
    entry.score += 1 / (RRF_K + i + 1);
  });

  let embedded = 0;
  if (semantic && documents.length > 0) {
    const { vectors, computed } = await embedDocuments(
      semantic.root,
      semantic.embedder,
      semantic.model,
      documents,
    );
    embedded = computed;
    const queryVector = await semantic.embedder.embedQuery(query);
    const byMeaning = documents
      .map((doc) => ({
        id: doc.id,
        similarity: cosine(queryVector, vectors.get(doc.id) as Float32Array),
      }))
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    byMeaning.forEach(({ id, similarity }, i) => {
      const entry = hit(id);
      entry.meaningRank = i + 1;
      entry.similarity = similarity;
      entry.score += 1 / (RRF_K + i + 1);
    });
  }

  const hitsRanked = [...hits.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
  return { hits: hitsRanked, embedded };
}
