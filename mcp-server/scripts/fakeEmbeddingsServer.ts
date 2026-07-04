/**
 * Minimal OpenAI-compatible embeddings server for the E2E test — no external network or real
 * API key required. Speaks the same contract embedRequestOnce() expects (POST {baseUrl}/embeddings,
 * body {model, input: string|string[], dimensions?}, response {data:[{index, embedding:number[]}]}),
 * so the real embedText()/embedTexts()/retry logic, Neo4j vector index, and semantic discrepancy
 * code all run for real.
 *
 * The vector for a given text is a deterministic hashed bag-of-words: texts sharing vocabulary
 * land close together in cosine similarity, unrelated texts land far apart. This is not a real
 * embedding model — it exists to exercise the wiring (HTTP round trip, storage, vector search,
 * threshold logic), not to demonstrate semantic understanding.
 */
import { createServer, type Server } from 'node:http';

export const FAKE_EMBEDDINGS_DIMENSIONS = 256;

// Structural markup from embeddingText()'s "type: X\nlabel: Y\ncontent: Z" wrapper, plus common
// Italian function words, carry little semantic weight in a real embedding model — filtered out
// here so the fake vectors are driven by content words, not by formatting boilerplate.
const NOISE_TOKENS = new Set([
  'type', 'label', 'content', 'metadata',
  'di', 'la', 'il', 'lo', 'le', 'gli', 'un', 'una', 'uno', 'con', 'che', 'per', 'e', 'a', 'in',
  'su', 'da', 'tra', 'fra', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'al', 'allo', 'alla',
  'ha', 'ho', 'hai', 'hanno', 'si', 'sua', 'suo', 'sue', 'suoi',
]);

export function fakeEmbeddingVector(text: string, dim = FAKE_EMBEDDINGS_DIMENSIONS): number[] {
  const vec = new Array(dim).fill(0);
  const tokens = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !NOISE_TOKENS.has(token));
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
    vec[hash % dim] += 1;
  }
  return vec;
}

export interface FakeEmbeddingsServerOptions {
  port: number;
  /** Number of times to answer with a transient 500 before succeeding, to exercise retry/backoff. */
  failFirstNRequests?: number;
}

export interface FakeEmbeddingsServerHandle {
  server: Server;
  requestCount: number;
  close: () => Promise<void>;
}

export async function startFakeEmbeddingsServer(options: FakeEmbeddingsServerOptions): Promise<FakeEmbeddingsServerHandle> {
  const handle: FakeEmbeddingsServerHandle = { server: null as unknown as Server, requestCount: 0, close: async () => {} };
  let remainingFailures = options.failFirstNRequests ?? 0;

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/embeddings')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      handle.requestCount++;
      if (remainingFailures > 0) {
        remainingFailures--;
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'simulated transient failure' }));
        return;
      }
      try {
        const parsed = JSON.parse(body) as { input?: string | string[]; dimensions?: number };
        const dim = parsed.dimensions && parsed.dimensions > 0 ? parsed.dimensions : FAKE_EMBEDDINGS_DIMENSIONS;
        // Like the real OpenAI-compatible contract (Ollama included), input may be a single
        // string or an array of texts — the batch path sends arrays.
        const inputs = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? '')];
        const data = inputs.map((text, index) => ({ index, embedding: fakeEmbeddingVector(String(text), dim) }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, '127.0.0.1', resolve));
  handle.server = server;
  handle.close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return handle;
}
