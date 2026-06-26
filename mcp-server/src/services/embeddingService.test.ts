import assert from 'node:assert/strict';
import test from 'node:test';
import { embedText, embeddingRuntimeStatus, EmbeddingConfigurationError, type EmbeddingSettings } from './embeddingService.js';

const configured: EmbeddingSettings = {
  provider: 'openai-compatible',
  apiKey: 'test-key',
  baseUrl: 'https://example.test/v1',
  model: 'text-embedding-test',
  dimensions: 3,
  timeoutMs: 1000,
};

test('embeddingRuntimeStatus reports missing provider configuration without creating fake vectors', () => {
  const status = embeddingRuntimeStatus({ ...configured, provider: '', apiKey: '', model: '' });
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ['EMBEDDINGS_PROVIDER']);
});

test('embedText calls an OpenAI-compatible embeddings endpoint and validates dimensions', async () => {
  let requestedUrl = '';
  let requestedBody: Record<string, unknown> = {};
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer test-key');
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  };

  const vector = await embedText('Gabriele cerca la verita', configured, fetchImpl);

  assert.equal(requestedUrl, 'https://example.test/v1/embeddings');
  assert.deepEqual(requestedBody, {
    model: 'text-embedding-test',
    input: 'Gabriele cerca la verita',
    dimensions: 3,
  });
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
});

test('embedText rejects invalid or unconfigured embeddings providers', async () => {
  await assert.rejects(
    () => embedText('test', { ...configured, provider: '' }, async () => new Response('{}')),
    (err: unknown) => err instanceof EmbeddingConfigurationError,
  );

  await assert.rejects(
    () => embedText('test', configured, async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })),
    /expected 3 dimensions/,
  );
});
