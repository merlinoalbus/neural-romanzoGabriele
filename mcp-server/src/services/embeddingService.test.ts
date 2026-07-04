import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkArray,
  clearEmbedCache,
  embedText,
  embedTextCached,
  embedTexts,
  embeddingRuntimeStatus,
  EmbeddingConfigurationError,
  type EmbeddingSettings,
} from './embeddingService.js';

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

test('embedTexts sends the whole batch as one array-input request and preserves input order', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    requests.push(body);
    // Reply out of order on purpose: `index` must map vectors back to inputs.
    const data = body.input
      .map((_, index) => ({ index, embedding: [index, index, index] }))
      .reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  };

  const vectors = await embedTexts(['a', 'b', 'c'], configured, fetchImpl);

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input, ['a', 'b', 'c']);
  assert.deepEqual(vectors, [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
  ]);
});

test('embedTexts splits inputs into batches of settings.batchSize', async () => {
  const requests: string[][] = [];
  const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    requests.push(body.input);
    return new Response(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }), { status: 200 });
  };

  const vectors = await embedTexts(['t1', 't2', 't3', 't4', 't5'], { ...configured, batchSize: 2 }, fetchImpl);

  assert.deepEqual(requests, [['t1', 't2'], ['t3', 't4'], ['t5']]);
  assert.equal(vectors.length, 5);
});

test('embedTexts rejects a response whose embedding count does not match the input count', async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  await assert.rejects(() => embedTexts(['a', 'b'], configured, fetchImpl), /expected 2 embeddings, received 1/);
});

test('embedTextCached returns the cached vector without a second provider call', async () => {
  clearEmbedCache();
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls++;
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 });
  };

  const first = await embedTextCached('stessa query', configured, fetchImpl);
  const second = await embedTextCached('stessa query', configured, fetchImpl);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);

  // A different model must never see the old model's vectors.
  await embedTextCached('stessa query', { ...configured, model: 'other-model' }, fetchImpl);
  assert.equal(calls, 2);
  clearEmbedCache();
});

test('chunkArray splits preserving order and handles empty input', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([], 3), []);
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
