import { config } from '../config.js';

export interface EmbeddingSettings {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
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

async function embedTextOnce(
  text: string,
  resolved: EmbeddingSettings,
  fetchImpl: FetchLike,
): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: resolved.model,
      input: text,
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
    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error('embedding_provider_error: response does not contain a valid numeric embedding');
    }
    if (resolved.dimensions > 0 && vector.length !== resolved.dimensions) {
      throw new Error(`embedding_provider_error: expected ${resolved.dimensions} dimensions, received ${vector.length}`);
    }
    return vector;
  } finally {
    clearTimeout(timer);
  }
}

export interface EmbedTextRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
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
  const resolved = requireEmbeddingSettings(settings);
  if (resolved.provider !== 'openai-compatible') {
    throw new EmbeddingConfigurationError(`Unsupported embeddings provider: ${resolved.provider}`);
  }
  if (!fetchImpl) throw new EmbeddingConfigurationError('fetch is not available in this runtime');

  const maxRetries = retry.maxRetries ?? 2;
  const baseDelayMs = retry.baseDelayMs ?? 300;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await embedTextOnce(text, resolved, fetchImpl);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof RetryableEmbeddingError;
      if (!retryable || attempt === maxRetries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
