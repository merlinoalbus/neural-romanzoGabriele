import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import { requestMcpEditor } from './mcpEditorClient.js';

test('editor proxy preserves a structured conflict response and sends the internal method/path', async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = '';
  let seenMethod = '';
  globalThis.fetch = (async (input, init) => {
    seenUrl = String(input);
    seenMethod = String(init?.method);
    return new Response(JSON.stringify({
      error: {
        code: 'DRAFT_VERSION_CONFLICT',
        details: { current: { revision: 4, contentHash: 'remote' } },
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const response = await requestMcpEditor('PUT', '/internal/editor/drafts/2', { sessionId: 'editing-002' });
    assert.equal(seenUrl, `${config.mcpEditorUrl}/internal/editor/drafts/2`);
    assert.equal(seenMethod, 'PUT');
    assert.equal(response.status, 409);
    assert.deepEqual(response.payload, {
      error: {
        code: 'DRAFT_VERSION_CONFLICT',
        details: { current: { revision: 4, contentHash: 'remote' } },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
