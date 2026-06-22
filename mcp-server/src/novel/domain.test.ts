import assert from 'node:assert/strict';
import test from 'node:test';
import { isNovelNodeType, NOVEL_CANON_STATUSES, NOVEL_DRAFT_STATUSES, NOVEL_NODE_TYPES, normalizeChapterLabel } from './domain.js';

test('novel node types are deterministic and unique', () => {
  assert.deepEqual([...NOVEL_NODE_TYPES], [...NOVEL_NODE_TYPES].sort());
  assert.equal(new Set(NOVEL_NODE_TYPES).size, NOVEL_NODE_TYPES.length);
});

test('novel node type guard accepts domain types only', () => {
  assert.equal(isNovelNodeType('artifact'), true);
  assert.equal(isNovelNodeType('character'), true);
  assert.equal(isNovelNodeType('knowledge_state'), true);
  assert.equal(isNovelNodeType('secret'), true);
  assert.equal(isNovelNodeType('world_rule'), true);
  assert.equal(isNovelNodeType('document'), false);
});

test('novel statuses are deterministic and unique', () => {
  assert.equal(new Set(NOVEL_CANON_STATUSES).size, NOVEL_CANON_STATUSES.length);
  assert.equal(new Set(NOVEL_DRAFT_STATUSES).size, NOVEL_DRAFT_STATUSES.length);
});

test('chapter labels are stable', () => {
  assert.equal(normalizeChapterLabel(12), 'Capitolo 12');
});
