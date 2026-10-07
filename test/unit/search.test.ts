import { describe, expect, it } from "vitest";
import {
  cosine,
  documentPrompt,
  queryPrompt,
  truncateAndNormalize,
} from "../../src/search/embedding.js";
import { lexicalRank } from "../../src/search/lexical.js";
import { type SearchDocument, tokenize } from "../../src/search/text.js";

const doc = (id: string, title: string, body = ""): SearchDocument => ({
  id,
  title,
  body,
  record: { file: `${id}.yaml`, kind: "knowledge", data: { id }, text: "" },
});

describe("search text", () => {
  it("lowercases, splits on punctuation, and folds plurals", () => {
    expect(tokenize("Sessions: refresh_cache, a, Class")).toEqual([
      "session",
      "refresh",
      "cache",
      "class",
    ]);
  });
});

describe("lexicalRank", () => {
  it("prefers title matches and rarer terms, and breaks ties by id", () => {
    const docs = [
      doc("b", "Retry policy", "uses exponential backoff for session refresh"),
      doc("a", "Session refresh", "reads the cache first"),
      doc("c", "Unrelated", "nothing here"),
    ];
    const ranked = lexicalRank(docs, "session refresh");
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(lexicalRank(docs, "zzz")).toEqual([]);
    expect(lexicalRank([doc("y", "same"), doc("x", "same")], "same").map((e) => e.id)).toEqual([
      "x",
      "y",
    ]);
  });
});

describe("embedding helpers", () => {
  it("cuts a Matryoshka vector and rescales it to unit length", () => {
    const cut = truncateAndNormalize([3, 4, 12], 2);
    expect(Array.from(cut)).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(cosine(cut, cut)).toBeCloseTo(1, 5);
  });

  it("applies EmbeddingGemma's task prompts only to that model", () => {
    expect(queryPrompt("onnx-community/embeddinggemma-300m-ONNX", "q")).toBe(
      "task: search result | query: q",
    );
    expect(documentPrompt("onnx-community/embeddinggemma-300m-ONNX", "T", "B")).toBe(
      "title: T | text: B",
    );
    expect(queryPrompt("other/model", "q")).toBe("q");
  });
});
