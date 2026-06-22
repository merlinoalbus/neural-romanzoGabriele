import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, mergeObj, stableKey } from './neo4jStore.js';

test('stableKey canonicalizes object keys', () => {
  assert.equal(stableKey({ b: 2, a: 1 }), stableKey({ a: 1, b: 2 }));
});

test('mergeObj deduplicates array values by value', () => {
  const merged = mergeObj({ tags: [{ a: 1, b: 2 }] }, { tags: [{ b: 2, a: 1 }, { c: 3 }] });
  assert.deepEqual(merged.tags, [{ a: 1, b: 2 }, { c: 3 }]);
});

test('chunkText keeps all content in ordered chunks', () => {
  const text = ['alpha', 'beta', 'gamma', 'delta'].join('\n\n');
  const chunks = chunkText(text, 500);
  assert.deepEqual(chunks, [text]);
  assert.equal(chunks.join('\n\n'), text);
});
