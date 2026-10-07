import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError } from "../core/errors.js";
import { git } from "../git/git.js";
import type { SearchDocument } from "./text.js";

/** A source of unit-length embedding vectors. All vectors from one embedder have equal length. */
export interface Embedder {
  /** Identifies the model and settings; cached vectors are reused only for the same id. */
  id: string;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface EmbedderConfig {
  model: string;
  /** Matryoshka output size; vectors are cut to this length and renormalized. */
  dimensions: number;
  /** ONNX weight precision, e.g. q8, q4, fp32. */
  dtype: string;
}

/** The ONNX export of google/embeddinggemma-300m that Transformers.js loads. */
export const DEFAULT_EMBEDDING_MODEL = "onnx-community/embeddinggemma-300m-ONNX";

/** EmbeddingGemma's task prompts (its model card); other models are given the text as is. */
export function queryPrompt(model: string, query: string): string {
  return isEmbeddingGemma(model) ? `task: search result | query: ${query}` : query;
}

export function documentPrompt(model: string, title: string, body: string): string {
  return isEmbeddingGemma(model)
    ? `title: ${title || "none"} | text: ${body}`
    : `${title}\n${body}`;
}

function isEmbeddingGemma(model: string): boolean {
  return /embeddinggemma/i.test(model);
}

/** Cuts a Matryoshka embedding to `dimensions` and rescales it to unit length. */
export function truncateAndNormalize(vector: ArrayLike<number>, dimensions: number): Float32Array {
  const size = Math.min(dimensions, vector.length);
  const out = new Float32Array(size);
  let norm = 0;
  for (let i = 0; i < size; i++) {
    const value = vector[i] ?? 0;
    out[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < size; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const size = Math.min(a.length, b.length);
  for (let i = 0; i < size; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Loaded by name at run time so the package stays an optional install. */
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{
  tolist(): number[][];
}>;

/**
 * Runs the model on this machine with Transformers.js (ONNX). The first run downloads the weights
 * from Hugging Face into its cache; after that nothing leaves the machine.
 */
export async function createTransformersEmbedder(config: EmbedderConfig): Promise<Embedder> {
  let transformers: { pipeline: (...args: unknown[]) => Promise<unknown> };
  try {
    transformers = (await import(TRANSFORMERS_PACKAGE)) as typeof transformers;
  } catch {
    throw new UsageError(
      `Semantic search needs ${TRANSFORMERS_PACKAGE}, which Alethic cannot find. Install it where Alethic is installed (in the alethic checkout: \`npm install ${TRANSFORMERS_PACKAGE}\`), or search without --semantic.`,
    );
  }
  let extractor: Extractor;
  try {
    extractor = (await transformers.pipeline("feature-extraction", config.model, {
      dtype: config.dtype,
    })) as Extractor;
  } catch (error) {
    throw new UsageError(
      `Could not load embedding model ${config.model}: ${(error as Error).message}. The first run downloads it from Hugging Face; set search.model in the manifest to use another model.`,
    );
  }
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = await extractor(texts.slice(i, i + 16), { pooling: "mean", normalize: true });
      for (const row of batch.tolist()) out.push(truncateAndNormalize(row, config.dimensions));
    }
    return out;
  };
  return {
    id: `${config.model}@${config.dtype}:${config.dimensions}`,
    embedDocuments: embed,
    embedQuery: async (text) => (await embed([queryPrompt(config.model, text)]))[0] as Float32Array,
  };
}

/**
 * The embedder to use. `ALETHIC_EMBEDDER_MODULE` names a module whose default export is
 * `(config) => Embedder | Promise<Embedder>`, for a hosted or already running model server; it
 * replaces the built-in Transformers.js embedder and is the only way Alethic runs outside code.
 */
export async function resolveEmbedder(
  config: EmbedderConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Embedder> {
  const custom = env.ALETHIC_EMBEDDER_MODULE;
  if (!custom) return createTransformersEmbedder(config);
  const url = pathToFileURL(path.resolve(cwd, custom)).href;
  let factory: unknown;
  try {
    factory = ((await import(url)) as { default?: unknown }).default;
  } catch (error) {
    throw new UsageError(
      `Could not load ALETHIC_EMBEDDER_MODULE ${custom}: ${(error as Error).message}`,
    );
  }
  if (typeof factory !== "function") {
    throw new UsageError(`ALETHIC_EMBEDDER_MODULE ${custom} must default-export a function`);
  }
  return (await factory(config)) as Embedder;
}

interface CacheFile {
  version: 1;
  embedder: string;
  vectors: Record<string, string>;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decode(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
}

/**
 * Where vectors are kept: inside the Git directory, so they are never committed, never show up in
 * `git status`, and are shared by every worktree of the clone. Vectors derive from record text and
 * are cheap to rebuild, so deleting the file is always safe.
 */
export async function cachePath(root: string): Promise<string | undefined> {
  const result = await git(root, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0) return undefined;
  return path.join(path.resolve(root, result.stdout.trim()), "alethic", "embeddings.json");
}

async function readCache(file: string | undefined, embedder: string): Promise<CacheFile> {
  const empty: CacheFile = { version: 1, embedder, vectors: {} };
  if (!file) return empty;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CacheFile>;
    if (parsed.version === 1 && parsed.embedder === embedder && parsed.vectors) {
      return { version: 1, embedder, vectors: parsed.vectors };
    }
  } catch {
    // Missing or unreadable: start again.
  }
  return empty;
}

export interface DocumentVectors {
  vectors: Map<string, Float32Array>;
  /** Documents embedded now, rather than found in the cache. */
  computed: number;
}

/**
 * One vector per document, keyed by the document's text, so an edited record is re-embedded and an
 * unchanged one never is. Entries for records that no longer exist are dropped.
 */
export async function embedDocuments(
  root: string,
  embedder: Embedder,
  model: string,
  documents: readonly SearchDocument[],
): Promise<DocumentVectors> {
  const file = await cachePath(root);
  const cache = await readCache(file, embedder.id);
  const prompts = documents.map((doc) => documentPrompt(model, doc.title, doc.body));
  const keys = prompts.map(digest);

  const missing = [...new Set(keys.filter((key) => !(key in cache.vectors)))];
  if (missing.length > 0) {
    const toEmbed = missing.map((key) => prompts[keys.indexOf(key)] as string);
    const embedded = await embedder.embedDocuments(toEmbed);
    if (embedded.length !== toEmbed.length) {
      throw new UsageError("The embedder returned a different number of vectors than documents");
    }
    missing.forEach((key, i) => {
      cache.vectors[key] = encode(embedded[i] as Float32Array);
    });
  }

  const live = new Set(keys);
  const kept: Record<string, string> = {};
  for (const key of live) kept[key] = cache.vectors[key] as string;
  if (file && (missing.length > 0 || Object.keys(cache.vectors).length !== live.size)) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, embedder: embedder.id, vectors: kept }));
      await rename(temp, file);
    } catch {
      // A cache that cannot be written only costs time on the next search.
    }
  }

  const vectors = new Map<string, Float32Array>();
  documents.forEach((doc, i) => {
    vectors.set(doc.id, decode(kept[keys[i] as string] as string));
  });
  return { vectors, computed: missing.length };
}
