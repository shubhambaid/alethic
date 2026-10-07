# Search

`alethic search "<query>"` finds records by words, and optionally by meaning. It exists for one question: *did anyone already decide, learn, or try this?*

[`resume`](cli.md#alethic-resume) cannot answer it. It retrieves deterministically, by links and by files, so a record that shares no link or path with your task never reaches the briefing. That is the right default for a briefing, and the wrong one for exploration.

```sh
alethic search "postgres sessions"                 # keywords (BM25); no model, no network
alethic search "what happens when a user logs out" --semantic
alethic search "retry" --kind checkpoint --limit 5 --json
```

Each result carries the same labels as [`alethic show`](cli.md#alethic-show): kind and status, trust, derived freshness, and how it matched. Only records that pass the shared assessment are searched, so a record with a secret or a forged trust label is never indexed, and the output says how many were withheld. `search` never writes records.

## Keywords and meaning

| | Keywords (default) | Meaning (`--semantic`) |
|---|---|---|
| Method | BM25 over each record's prose; the summary counts twice | Cosine similarity between local embeddings |
| Needs | Nothing | `@huggingface/transformers` and a one-time model download |
| Finds | Exact and near-exact vocabulary | "log out" when the record says "sign out" |
| Fails on | Synonyms and paraphrase | A project's private vocabulary, which a general model has not seen |
| Deterministic | Yes | Given the same model, yes |

With `--semantic`, both rankings are fused by reciprocal rank (k = 60), so an exact keyword match stays near the top even when the model has never seen the project's terms, and a paraphrase still surfaces. Fusing ranks instead of scores avoids calibrating BM25 against cosine similarity.

`resume`, `validate`, and every other command stay deterministic and model-free. Search is the only place a model appears, and only when asked for.

## Enabling semantic search

```sh
npm install @huggingface/transformers        # run where Alethic is installed (the clone you built); an optional peer dependency
alethic search "token reuse after logout" --semantic
```

The first run downloads the model from Hugging Face into the Transformers.js cache. After that, embedding runs on your machine: record text is never sent anywhere. To make it the default for the repository:

```yaml
# .alethic/manifest.yaml
search:
  semantic: true
```

With `search.semantic: true`, a missing package or model falls back to keywords with a note on stderr. An explicit `--semantic` fails instead, because silently searching a different way would be a wrong answer with a straight face. `--no-semantic` turns it off for one search.

### Model

The default is **EmbeddingGemma** (`google/embeddinggemma-300m`, loaded as its ONNX export `onnx-community/embeddinggemma-300m-ONNX`): a 308M-parameter multilingual embedding model from Google that runs on CPU, built for on-device use. Alethic follows its model card:

- **Task prompts.** Queries are embedded as `task: search result | query: …` and records as `title: … | text: …`. Other models receive the text unchanged.
- **Matryoshka dimensions.** The model is trained so a vector can be cut to 768, 512, 256, or 128 values and renormalized. Alethic defaults to 256: a ledger of a thousand records is about a megabyte of cache, and ranking over a few hundred prose records loses little at that size. Set `search.dimensions` to change it.
- **Precision.** `search.dtype` selects the ONNX weights (default `q8`; `q4` is smaller, `fp32` the most exact).

`search.model` accepts any feature-extraction model Transformers.js can load. A different model changes the cache key, so vectors from two models are never mixed.

> **Not yet verified against the real model.** The embedding path is tested with a deterministic stand-in embedder, which exercises fusion, caching, and fallbacks. It has not been run against the downloaded EmbeddingGemma weights: the environment this was written in cannot reach Hugging Face. Treat the first real run as a check of the model identifier, the `dtype` default, and the quality of the ranking, and report what differs. The model id `google/embeddinggemma-2` that prompted this work could not be confirmed to exist; the published model is `google/embeddinggemma-300m`.

### Where vectors are kept

In `$(git rev-parse --git-common-dir)/alethic/embeddings.json`: inside the Git directory, so it is never committed, never appears in `git status`, and is shared by every worktree of the clone. Each vector is keyed by a hash of the record's text, so an edited record is re-embedded and an unchanged one never is, and entries for deleted records are dropped. Deleting the file is always safe.

### Bring your own embedder

Set `ALETHIC_EMBEDDER_MODULE` to a JavaScript module whose default export is `(config) => Embedder`, to use a model server you already run (Ollama, llama.cpp, a hosted endpoint):

```js
// my-embedder.mjs
export default function create({ model, dimensions }) {
  return {
    id: `ollama:${model}:${dimensions}`,           // part of the cache key
    async embedDocuments(texts) { /* → Float32Array[] of unit vectors */ },
    async embedQuery(text) { /* → Float32Array */ },
  };
}
```

This runs code you name in your own environment. A module that calls a hosted API sends record text to it, and the privacy boundary ([spec §13](spec.md#13-privacy-boundary)) then depends on that provider.

## MCP

The `search` tool runs `search --json` with the same checks. An agent can call it before work that shares no files with its task:

```json
{ "query": "refresh token reuse", "kind": ["decision", "checkpoint"], "limit": 5 }
```

## Why this design

The market for coding-agent memory moved quickly in 2026. [Guides to the category](https://www.cognee.ai/memory-tooling-ai-coding-agents) list tools such as Mem0, Cognee, and the open-source AgentMemory (which [reached the top of Product Hunt in May](https://hunted.space/dashboard/agent-memory-dev)). They share a pattern: a service captures what agents do, compresses it, and retrieves it by embedding similarity.

That pattern recalls well and proves little. The memory sits outside the repository, so it is not reviewed in pull requests, does not branch with the code, and says nothing when the code it describes has changed. Alethic's position is the opposite: small committed records, validated before use, anchored to content. The gap in that position was recall. An agent could trust what it was handed, but could not look for what it was not handed.

Search closes that gap without giving up the position:

- **Retrieval is local and derived.** The ledger stays the source of truth. Vectors are a disposable cache outside Git, never a store of record.
- **Results are checked.** A semantic hit comes with its freshness and trust, so "similar" is never read as "still true". Similarity ranks; it does not vouch.
- **Nothing is required.** Without the optional package, search is BM25 and the tool has no new dependency, no model, and no network access.

Not built, on purpose: embedding-based inclusion in `resume`. It would trade the byte-identical briefing for recall, and it would be hard to say why a record was or was not included. If real sessions show agents missing records that search would have found, the better move is a "see also" line in the briefing that points at `search`, not a model-ranked section.
