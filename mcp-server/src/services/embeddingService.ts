import { createHash } from 'node:crypto';
import { config } from '../config.js';

export interface EmbeddingSettings {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  /** Max texts per provider request when batching. Optional so existing call sites/tests stay valid. */
  batchSize?: number;
}

export interface EmbeddingRuntimeStatus {
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  dimensions: number | null;
  missing: string[];
}

export class EmbeddingConfigurationError extends Error {
  readonly code = 'EMBEDDINGS_NOT_CONFIGURED';
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function getEmbeddingSettings(): EmbeddingSettings {
  return {
    provider: config.embeddingsProvider,
    apiKey: config.embeddingsApiKey,
    baseUrl: config.embeddingsBaseUrl,
    model: config.embeddingsModel,
    dimensions: config.embeddingsDimensions,
    timeoutMs: config.embeddingsTimeoutMs,
    batchSize: config.embeddingsBatchSize,
  };
}

export function embeddingRuntimeStatus(settings: EmbeddingSettings = getEmbeddingSettings()): EmbeddingRuntimeStatus {
  const missing: string[] = [];
  if (!settings.provider.trim()) missing.push('EMBEDDINGS_PROVIDER');
  if (settings.provider && settings.provider !== 'openai-compatible') missing.push('EMBEDDINGS_PROVIDER=openai-compatible');
  if (settings.provider === 'openai-compatible' && !settings.apiKey.trim()) missing.push('EMBEDDINGS_API_KEY');
  if (settings.provider === 'openai-compatible' && !settings.model.trim()) missing.push('EMBEDDINGS_MODEL');
  return {
    configured: missing.length === 0,
    provider: settings.provider || 'disabled',
    model: settings.model,
    baseUrl: settings.baseUrl,
    dimensions: settings.dimensions > 0 ? settings.dimensions : null,
    missing,
  };
}

export function requireEmbeddingSettings(settings: EmbeddingSettings = getEmbeddingSettings()): EmbeddingSettings {
  const status = embeddingRuntimeStatus(settings);
  if (!status.configured) {
    throw new EmbeddingConfigurationError(`Embeddings provider is not configured: missing ${status.missing.join(', ')}`);
  }
  return settings;
}

export function embeddingText(input: { type: string; label: string; content: string; metadata?: Record<string, unknown> }): string {
  const metadata = input.metadata && Object.keys(input.metadata).length ? `\nmetadata: ${JSON.stringify(input.metadata)}` : '';
  return [`type: ${input.type}`, `label: ${input.label}`, `content: ${input.content}`].join('\n') + metadata;
}

export class RetryableEmbeddingError extends Error {
  readonly retryable = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateVector(vector: unknown, expectedDimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('embedding_provider_error: response does not contain a valid numeric embedding');
  }
  if (expectedDimensions > 0 && vector.length !== expectedDimensions) {
    throw new Error(`embedding_provider_error: expected ${expectedDimensions} dimensions, received ${vector.length}`);
  }
  return vector as number[];
}

/**
 * One provider round-trip for one or many texts. The OpenAI-compatible `/embeddings` endpoint
 * (including Ollama's) accepts an array input, so a whole batch costs a single HTTP request and
 * lets the provider schedule the texts together on the GPU instead of one prompt at a time.
 * A single string is still sent as a plain string for exact backward compatibility.
 */
async function embedRequestOnce(
  input: string | string[],
  resolved: EmbeddingSettings,
  fetchImpl: FetchLike,
): Promise<number[][]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  const expectedCount = Array.isArray(input) ? input.length : 1;
  try {
    const body: Record<string, unknown> = {
      model: resolved.model,
      input,
    };
    if (resolved.dimensions > 0) body.dimensions = resolved.dimensions;
    let response: Response;
    try {
      response = await fetchImpl(`${resolved.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${resolved.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure or timeout abort: transient, worth retrying.
      throw new RetryableEmbeddingError(`embedding_provider_network_error: ${String(err)}`);
    }
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      const detail = `embedding_provider_error: ${response.status} ${response.statusText}${message ? ` - ${message}` : ''}`;
      // 429 (rate limit) and 5xx are transient; other 4xx (auth, bad request) will not succeed on retry.
      if (response.status === 429 || response.status >= 500) throw new RetryableEmbeddingError(detail);
      throw new Error(detail);
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown; index?: unknown }> };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== expectedCount) {
      throw new Error(`embedding_provider_error: expected ${expectedCount} embeddings, received ${Array.isArray(data) ? data.length : 0}`);
    }
    // The spec does not guarantee response order; `index` maps each vector back to its input.
    const vectors: number[][] = new Array(expectedCount);
    for (let position = 0; position < data.length; position++) {
      const item = data[position];
      const index = typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : position;
      if (index < 0 || index >= expectedCount || vectors[index]) {
        throw new Error('embedding_provider_error: response contains invalid or duplicate embedding indexes');
      }
      vectors[index] = validateVector(item.embedding, resolved.dimensions);
    }
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbedTextRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

function resolveForRequest(settings: EmbeddingSettings, fetchImpl: FetchLike): EmbeddingSettings {
  const resolved = requireEmbeddingSettings(settings);
  if (resolved.provider !== 'openai-compatible') {
    throw new EmbeddingConfigurationError(`Unsupported embeddings provider: ${resolved.provider}`);
  }
  if (!fetchImpl) throw new EmbeddingConfigurationError('fetch is not available in this runtime');
  return resolved;
}

async function embedWithRetry(
  input: string | string[],
  resolved: EmbeddingSettings,
  fetchImpl: FetchLike,
  retry: EmbedTextRetryOptions,
): Promise<number[][]> {
  const maxRetries = retry.maxRetries ?? 2;
  const baseDelayMs = retry.baseDelayMs ?? 300;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await embedRequestOnce(input, resolved, fetchImpl);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof RetryableEmbeddingError;
      if (!retryable || attempt === maxRetries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Embeds a single text, retrying transient failures (timeouts, network errors, 429/5xx) with
 * exponential backoff. Configuration errors and permanent provider errors (4xx other than 429,
 * malformed response) fail immediately without retrying.
 */
export async function embedText(
  text: string,
  settings: EmbeddingSettings = getEmbeddingSettings(),
  fetchImpl: FetchLike = globalThis.fetch,
  retry: EmbedTextRetryOptions = {},
): Promise<number[]> {
  const resolved = resolveForRequest(settings, fetchImpl);
  const vectors = await embedWithRetry(text, resolved, fetchImpl, retry);
  return vectors[0];
}

export const DEFAULT_EMBEDDINGS_BATCH_SIZE = 32;

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.trunc(size));
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    chunks.push(items.slice(start, start + chunkSize));
  }
  return chunks;
}

/**
 * Embeds many texts with as few provider round-trips as possible: texts are grouped into
 * batches of `settings.batchSize` (default 32) and each batch is one HTTP request. Output
 * order matches input order. Same retry semantics as `embedText`, applied per batch.
 */
export async function embedTexts(
  texts: string[],
  settings: EmbeddingSettings = getEmbeddingSettings(),
  fetchImpl: FetchLike = globalThis.fetch,
  retry: EmbedTextRetryOptions = {},
): Promise<number[][]> {
  if (!texts.length) return [];
  const resolved = resolveForRequest(settings, fetchImpl);
  const batchSize = resolved.batchSize && resolved.batchSize > 0 ? resolved.batchSize : DEFAULT_EMBEDDINGS_BATCH_SIZE;
  const vectors: number[][] = [];
  for (const batch of chunkArray(texts, batchSize)) {
    vectors.push(...(await embedWithRetry(batch, resolved, fetchImpl, retry)));
  }
  return vectors;
}

// Small in-process LRU for query-style embeddings (semantic search queries, discrepancy-gate
// candidate texts re-checked by validators). Embedding a fixed text with a fixed model is
// deterministic enough for caching, and a hit saves a full GPU round-trip. Keyed by
// model+dimensions so a model switch can never serve vectors from the old space.
const EMBED_CACHE_MAX_ENTRIES = 512;
const embedCache = new Map<string, number[]>();

function embedCacheKey(text: string, settings: EmbeddingSettings): string {
  return `${settings.model}|${settings.dimensions}|${createHash('sha256').update(text).digest('hex')}`;
}

export function clearEmbedCache(): void {
  embedCache.clear();
}

/**
 * `embedText` with an LRU cache in front. Use for read-path embeddings (queries, gate checks)
 * where the same text is often re-embedded within a session; write-path node embeddings go
 * through the textHash skip logic in embeddingSync instead.
 */
export async function embedTextCached(
  text: string,
  settings: EmbeddingSettings = getEmbeddingSettings(),
  fetchImpl: FetchLike = globalThis.fetch,
  retry: EmbedTextRetryOptions = {},
): Promise<number[]> {
  const key = embedCacheKey(text, settings);
  const hit = embedCache.get(key);
  if (hit) {
    // Refresh recency so hot queries stay resident.
    embedCache.delete(key);
    embedCache.set(key, hit);
    return hit;
  }
  const vector = await embedText(text, settings, fetchImpl, retry);
  embedCache.set(key, vector);
  if (embedCache.size > EMBED_CACHE_MAX_ENTRIES) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  return vector;
}
