import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCanonicalKind, isCanonicalKind, KG_KINDS_LIST } from './ontology.js';

test('relation vocabulary accepts canonical kinds', () => {
  assert.equal(isCanonicalKind('mentions'), true);
  assert.equal(isCanonicalKind('appears_in'), true);
  assert.equal(isCanonicalKind('has_voice'), true);
  assert.equal(isCanonicalKind('pays_off'), true);
  assert.equal(isCanonicalKind('related_to'), true);
});

test('relation vocabulary rejects unknown kinds', () => {
  assert.equal(isCanonicalKind('made_up_kind'), false);
  assert.throws(() => assertCanonicalKind('made_up_kind'), /invalid_kind/);
});

test('relation vocabulary list is deterministic', () => {
  assert.deepEqual([...KG_KINDS_LIST], [...KG_KINDS_LIST].sort());
});
