// A deterministic stand-in for an embedding model: each concept is one axis, and a text's vector
// counts the words it uses from each concept. "logout" and "sign out" land near "session end"
// although they share no keyword, which is the case a real model is there to handle.
const CONCEPTS = [
  ["session", "sessions", "login", "logout", "signout", "token", "cookie", "expire"],
  ["database", "postgres", "sql", "store", "storage", "persist", "table"],
  ["deploy", "release", "ship", "rollout", "publish"],
];
const TEXT_ALIASES = { "sign out": "signout", "log out": "logout", "log in": "login" };

function vectorOf(text, dimensions) {
  let lowered = text.toLowerCase();
  for (const [phrase, word] of Object.entries(TEXT_ALIASES))
    lowered = lowered.replaceAll(phrase, word);
  const words = lowered.match(/[a-z]+/g) ?? [];
  const raw = new Float32Array(dimensions);
  CONCEPTS.forEach((concept, axis) => {
    for (const word of words) if (concept.includes(word)) raw[axis] += 1;
  });
  raw[dimensions - 1] = 0.01; // never the zero vector
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map((value) => value / norm);
}

export default function createEmbedder(config) {
  globalThis.__alethicEmbedCalls = globalThis.__alethicEmbedCalls ?? [];
  return {
    id: `fake:${config.dimensions}`,
    async embedDocuments(texts) {
      globalThis.__alethicEmbedCalls.push(texts.length);
      return texts.map((text) => vectorOf(text, config.dimensions));
    },
    async embedQuery(text) {
      return vectorOf(text, config.dimensions);
    },
  };
}
