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

export async function embedText(
  text: string,
  settings: EmbeddingSettings = getEmbeddingSettings(),
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<number[]> {
  const resolved = requireEmbeddingSettings(settings);
  if (resolved.provider !== 'openai-compatible') {
    throw new EmbeddingConfigurationError(`Unsupported embeddings provider: ${resolved.provider}`);
  }
  if (!fetchImpl) throw new EmbeddingConfigurationError('fetch is not available in this runtime');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: resolved.model,
      input: text,
    };
    if (resolved.dimensions > 0) body.dimensions = resolved.dimensions;
    const response = await fetchImpl(`${resolved.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${resolved.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`embedding_provider_error: ${response.status} ${response.statusText}${message ? ` - ${message}` : ''}`);
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
