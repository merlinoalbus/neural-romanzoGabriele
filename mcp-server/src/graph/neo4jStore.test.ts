import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  chunkText,
  classifyNonRelPhysicalEdge,
  embeddingTextHash,
  mergeObj,
  stableKey,
  summarizeNonRelPhysicalEdgeRepair,
  type NonRelPhysicalEdgeCandidate,
} from './neo4jStore.js';

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

test('embeddingTextHash is deterministic and content-sensitive', () => {
  assert.equal(embeddingTextHash('Gabriele'), embeddingTextHash('Gabriele'));
  assert.notEqual(embeddingTextHash('Gabriele'), embeddingTextHash('Raffaele'));
});

function nonRelEdge(overrides: Partial<NonRelPhysicalEdgeCandidate>): NonRelPhysicalEdgeCandidate {
  return {
    physicalType: 'Relationship',
    rawKind: 'REL',
    fromId: 'from',
    toId: 'to',
    fromType: 'bible_candidate',
    toType: 'bible_section',
    metadata: '{}',
    provenance: '{}',
    ...overrides,
  };
}

test('classifyNonRelPhysicalEdge maps off-schema relationships without generic fallbacks', () => {
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ fromId: 'same', toId: 'same' })), {
    action: 'remove',
    reason: 'self_loop_redundant',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({
    rawKind: 'ally_of',
    fromType: 'character',
    toType: 'faction',
    metadata: '{"inferred":true,"rule":"char_faction_intermediate"}',
    provenance: '{"source":"consolidation_engine"}',
  })), {
    action: 'remove',
    reason: 'legacy_overgenerated_ally_of',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ physicalType: 'applies_to', rawKind: '', fromType: 'continuity_finding', toType: 'plot_thread' })), {
    action: 'convert',
    kind: 'applies_to',
    reason: 'canonical_physical_type',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ metadata: '{"parentSectionKey":"2.3"}', fromType: 'bible_section', toType: 'bible_section' })), {
    action: 'convert',
    kind: 'part_of',
    reason: 'section_parent_metadata',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ metadata: '{"orderScope":"document"}', fromType: 'bible_section', toType: 'bible_section' })), {
    action: 'convert',
    kind: 'precedes',
    reason: 'section_order_metadata',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ fromType: 'world_rule', toType: 'world_rule', metadata: '{"candidateId":"edge-exception-rule"}' })), {
    action: 'convert',
    kind: 'is_exception_to',
    reason: 'world_rule_exception',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ fromType: 'bible_coverage_finding', toType: 'artifact' })), {
    action: 'convert',
    kind: 'applies_to',
    reason: 'coverage_target',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ fromType: 'secret', toType: 'bible_section' })), {
    action: 'convert',
    kind: 'derived_from',
    reason: 'source_section_evidence',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ fromType: 'unknown_type', toType: 'bible_section' })), {
    action: 'unresolved',
    reason: 'no_specific_mapping',
  });
  assert.deepEqual(classifyNonRelPhysicalEdge(nonRelEdge({ physicalType: 'Relationship', rawKind: 'REL', fromType: 'world_rule', toType: 'world_rule' })), {
    action: 'unresolved',
    reason: 'no_specific_mapping',
  });
});

test('summarizeNonRelPhysicalEdgeRepair reconciles converted removed and unresolved counts', () => {
  const edges = [
    ...Array.from({ length: 401 }, (_, index) => nonRelEdge({ fromId: `candidate-${index}`, toId: `section-${index}` })),
    ...Array.from({ length: 195 }, (_, index) => nonRelEdge({
      rawKind: 'ally_of',
      fromId: `character-${index}`,
      toId: `faction-${index}`,
      fromType: 'character',
      toType: 'faction',
      metadata: '{"inferred":true,"rule":"char_faction_intermediate"}',
      provenance: '{"source":"consolidation_engine"}',
    })),
    ...Array.from({ length: 7 }, (_, index) => nonRelEdge({ fromId: `self-${index}`, toId: `self-${index}` })),
    nonRelEdge({ fromId: 'unresolved', toId: 'target', fromType: 'unknown_type', toType: 'bible_section' }),
  ];
  const plan = summarizeNonRelPhysicalEdgeRepair(edges);
  assert.equal(plan.total, 604);
  assert.equal(plan.converted, 401);
  assert.equal(plan.removed, 202);
  assert.equal(plan.unresolved, 1);
  assert.equal(plan.convertedByKind.derived_from, 401);
  assert.equal(plan.removedByReason.legacy_overgenerated_ally_of, 195);
  assert.equal(plan.removedByReason.self_loop_redundant, 7);
  assert.equal(plan.unresolvedBySignature['Relationship/REL/unknown_type->bible_section'], 1);
});

test('Bible section scoped store queries exclude child section prefixes', async () => {
  const source = await readFile(new URL('./neo4jStore.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('n.label STARTS WITH $labelPrefix'), false);
  assert.equal(source.includes('labelChildPrefix'), false);
  assert.equal(source.includes('labelCandidatePrefix: `${sourceId}::${sectionKey}::`'), true);
  assert.equal(source.includes('getBibleCandidateByIdOrLabel'), true);
});
