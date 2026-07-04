import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
import type { BibleCandidate } from './bibleCandidates.js';
import { buildBibleDiscrepancyReport, buildCanonDiscrepancyReport, buildSemanticDiscrepancies, type SemanticDiscrepancyOptions } from './bibleDiscrepancy.js';

function node(input: Partial<GraphNode> & { id: string; type: string; label: string; content?: string }): GraphNode {
  return {
    id: input.id,
    type: input.type,
    label: input.label,
    content: input.content ?? input.label,
    metadata: input.metadata ?? { canonStatus: 'canonical' },
    provenance: input.provenance ?? {},
    createdAt: input.createdAt ?? '',
    updatedAt: input.updatedAt ?? '',
  };
}

function edge(input: Partial<GraphEdge> & { id: string; fromId: string; toId: string; kind: string }): GraphEdge {
  return {
    id: input.id,
    fromId: input.fromId,
    toId: input.toId,
    kind: input.kind,
    weight: input.weight ?? 1,
    metadata: input.metadata ?? {},
    provenance: input.provenance ?? {},
    createdAt: input.createdAt ?? '',
  };
}

function nodeCandidate(input: Partial<BibleCandidate> & { candidateId: string; targetType: string; label: string; content: string }): BibleCandidate {
  return {
    candidateId: input.candidateId,
    candidateKind: 'node',
    targetType: input.targetType as BibleCandidate['targetType'],
    label: input.label,
    content: input.content,
    evidence: input.evidence ?? { sourceId: 'bibbia', sectionKey: '1' },
    confidence: input.confidence ?? 0.9,
    rationale: input.rationale ?? 'test',
    metadata: input.metadata ?? {},
  };
}

function edgeCandidate(input: {
  candidateId: string;
  relationKind: string;
  from: { type: string; label: string };
  to: { type: string; label: string };
}): BibleCandidate {
  return {
    candidateId: input.candidateId,
    candidateKind: 'edge',
    relationKind: input.relationKind,
    from: input.from as BibleCandidate['from'],
    to: input.to as BibleCandidate['to'],
    evidence: { sourceId: 'bibbia', sectionKey: '1' },
    confidence: 0.9,
    rationale: 'test',
    metadata: {},
  };
}

test('buildBibleDiscrepancyReport blocks polarity conflicts with canonical nodes', () => {
  const report = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-1',
      targetType: 'knowledge_state',
      label: 'Lisa conoscenza segreto',
      content: 'Lisa non sa il segreto di Michael.',
    })],
    [node({
      id: 'node-1',
      type: 'knowledge_state',
      label: 'Lisa conoscenza segreto',
      content: 'Lisa sa il segreto di Michael.',
    })],
    [],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'content_polarity_conflict' && item.blocking));
});

test('buildBibleDiscrepancyReport blocks same-label canonical content drift unless author approved', () => {
  const existing = node({
    id: 'node-1',
    type: 'theme',
    label: 'Identita',
    content: 'Tema della scoperta di se.',
  });

  const blocked = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-1',
      targetType: 'theme',
      label: 'Identita',
      content: 'Tema della fuga da se.',
    })],
    [existing],
    [],
  );

  assert.equal(blocked.hasBlockingDiscrepancies, true);
  assert.ok(blocked.discrepancies.some((item) => item.code === 'same_label_content_drift' && item.blocking));

  const approved = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-2',
      targetType: 'theme',
      label: 'Identita',
      content: 'Tema della fuga da se.',
      metadata: { discrepancyResolution: 'author_approved_content_update' },
    })],
    [existing],
    [],
  );

  assert.equal(approved.hasBlockingDiscrepancies, false);
  assert.ok(approved.discrepancies.some((item) => item.code === 'same_label_content_drift' && item.authorized));
});

test('buildBibleDiscrepancyReport blocks strong alias duplicates', () => {
  const report = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-1',
      targetType: 'character',
      label: 'Gabriele Colombo',
      content: 'Protagonista timido e sensibile.',
    })],
    [node({
      id: 'node-1',
      type: 'character',
      label: 'Gabriele',
      content: 'Protagonista timido e sensibile.',
    })],
    [],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'possible_duplicate_or_alias' && item.blocking));
});

test('buildBibleDiscrepancyReport blocks canonical aliases with equal normalized labels and different raw labels', () => {
  const report = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-1',
      targetType: 'character',
      label: 'Gabriele-Colombo',
      content: 'Protagonista timido e sensibile.',
    })],
    [node({
      id: 'node-1',
      type: 'character',
      label: 'Gabriele Colombo',
      content: 'Protagonista timido e sensibile.',
    })],
    [],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'possible_duplicate_or_alias' && item.blocking));
});

test('buildBibleDiscrepancyReport allows normalized-label alias only with author approved merge', () => {
  const existing = node({
    id: 'node-1',
    type: 'character',
    label: 'Gabriele Colombo',
    content: 'Protagonista timido e sensibile.',
  });

  const wrongOverride = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-1',
      targetType: 'character',
      label: 'Gabriele-Colombo',
      content: 'Protagonista timido e sensibile.',
      metadata: { discrepancyResolution: 'author_approved_content_update' },
    })],
    [existing],
    [],
  );

  assert.equal(wrongOverride.hasBlockingDiscrepancies, true);
  assert.ok(wrongOverride.discrepancies.some((item) => item.code === 'possible_duplicate_or_alias' && item.blocking));

  const mergeOverride = buildBibleDiscrepancyReport(
    [nodeCandidate({
      candidateId: 'cand-2',
      targetType: 'character',
      label: 'Gabriele-Colombo',
      content: 'Protagonista timido e sensibile.',
      metadata: { discrepancyResolution: 'author_approved_merge' },
    })],
    [existing],
    [],
  );

  assert.equal(mergeOverride.hasBlockingDiscrepancies, false);
  assert.ok(mergeOverride.discrepancies.some((item) => item.code === 'possible_duplicate_or_alias' && item.authorized));
});

test('buildBibleDiscrepancyReport blocks intra-batch aliases with equal normalized labels and different raw labels', () => {
  const report = buildBibleDiscrepancyReport(
    [
      nodeCandidate({
        candidateId: 'cand-1',
        targetType: 'character',
        label: 'Gabriele Colombo',
        content: 'Protagonista timido e sensibile.',
      }),
      nodeCandidate({
        candidateId: 'cand-2',
        targetType: 'character',
        label: 'Gabriele-Colombo',
        content: 'Protagonista timido e sensibile.',
      }),
    ],
    [],
    [],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'intra_batch_possible_duplicate_or_alias' && item.blocking));
});

test('buildBibleDiscrepancyReport blocks candidate edges that oppose canonical contradiction edges', () => {
  const lisa = node({ id: 'lisa', type: 'character', label: 'Lisa' });
  const secret = node({ id: 'secret', type: 'secret', label: 'Segreto Michael' });
  const report = buildBibleDiscrepancyReport(
    [edgeCandidate({
      candidateId: 'cand-edge',
      relationKind: 'supports',
      from: { type: 'character', label: 'Lisa' },
      to: { type: 'secret', label: 'Segreto Michael' },
    })],
    [lisa, secret],
    [edge({ id: 'edge-1', fromId: lisa.id, toId: secret.id, kind: 'contradicts' })],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'edge_conflicts_with_existing_contradiction' && item.blocking));
});

test('buildBibleDiscrepancyReport blocks intra-batch opposing edges', () => {
  const report = buildBibleDiscrepancyReport(
    [
      edgeCandidate({
        candidateId: 'cand-knows',
        relationKind: 'knows',
        from: { type: 'character', label: 'Lisa' },
        to: { type: 'secret', label: 'Segreto Michael' },
      }),
      edgeCandidate({
        candidateId: 'cand-does-not-know',
        relationKind: 'does_not_know',
        from: { type: 'character', label: 'Lisa' },
        to: { type: 'secret', label: 'Segreto Michael' },
      }),
    ],
    [],
    [],
  );

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'intra_batch_opposing_edge_kind_conflict' && item.blocking));
});

function fakeSemanticOptions(input: { score: number; matchNode: GraphNode }): SemanticDiscrepancyOptions {
  return {
    embedText: async () => [0.1, 0.2, 0.3],
    semanticSearch: async () => [{ node: input.matchNode, score: input.score }],
  };
}

test('buildSemanticDiscrepancies blocks near-identical meaning even with completely different wording', async () => {
  const existing = node({ id: 'n-1', type: 'secret', label: 'Il segreto del ciondolo', content: 'Nessuno conosce la vera origine del ciondolo del Nonno.' });
  const candidate = nodeCandidate({ candidateId: 'cand-paraphrase', targetType: 'secret', label: 'Origine misteriosa del gioiello', content: 'Il gioiello di famiglia porta con se un passato che tutti ignorano.' });

  const discrepancies = await buildSemanticDiscrepancies([candidate], fakeSemanticOptions({ score: 0.95, matchNode: existing }));

  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0].code, 'possible_duplicate_or_alias_semantic');
  assert.equal(discrepancies[0].blocking, true);
});

test('buildSemanticDiscrepancies raises only a non-blocking advisory in the mid-similarity band', async () => {
  const existing = node({ id: 'n-2', type: 'secret', label: 'Altro segreto' });
  const candidate = nodeCandidate({ candidateId: 'cand-mid', targetType: 'secret', label: 'Segreto diverso', content: 'Testo diverso.' });

  const discrepancies = await buildSemanticDiscrepancies([candidate], fakeSemanticOptions({ score: 0.85, matchNode: existing }));

  assert.equal(discrepancies.length, 1);
  assert.equal(discrepancies[0].code, 'semantic_proximity_review');
  assert.equal(discrepancies[0].severity, 'warning');
  assert.equal(discrepancies[0].blocking, false);
});

test('buildSemanticDiscrepancies stays silent below the review threshold', async () => {
  const existing = node({ id: 'n-3', type: 'secret', label: 'Segreto scollegato' });
  const candidate = nodeCandidate({ candidateId: 'cand-low', targetType: 'secret', label: 'Segreto indipendente', content: 'Testo indipendente.' });

  const discrepancies = await buildSemanticDiscrepancies([candidate], fakeSemanticOptions({ score: 0.4, matchNode: existing }));

  assert.equal(discrepancies.length, 0);
});

test('buildSemanticDiscrepancies never throws when the embeddings provider fails', async () => {
  const candidate = nodeCandidate({ candidateId: 'cand-fail', targetType: 'secret', label: 'X', content: 'Y' });
  const discrepancies = await buildSemanticDiscrepancies([candidate], {
    embedText: async () => {
      throw new Error('provider down');
    },
    semanticSearch: async () => [],
  });
  assert.deepEqual(discrepancies, []);
});

test('buildSemanticDiscrepancies embeds all candidates in one batch call when embedTexts is provided', async () => {
  const existing = node({ id: 'n-batch', type: 'secret', label: 'Segreto batch', content: 'Contenuto.' });
  const candidates = [
    nodeCandidate({ candidateId: 'cand-a', targetType: 'secret', label: 'Segreto A', content: 'Testo A.' }),
    nodeCandidate({ candidateId: 'cand-b', targetType: 'secret', label: 'Segreto B', content: 'Testo B.' }),
    nodeCandidate({ candidateId: 'cand-c', targetType: 'secret', label: 'Segreto C', content: 'Testo C.' }),
  ];
  let batchCalls = 0;
  let singleCalls = 0;
  const discrepancies = await buildSemanticDiscrepancies(candidates, {
    embedText: async () => {
      singleCalls++;
      return [0.1, 0.2, 0.3];
    },
    embedTexts: async (texts) => {
      batchCalls++;
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
    semanticSearch: async () => [{ node: existing, score: 0.95 }],
  });

  assert.equal(batchCalls, 1);
  assert.equal(singleCalls, 0);
  assert.equal(discrepancies.length, 3);
});

test('buildSemanticDiscrepancies falls back to per-candidate embeds when the batch call fails', async () => {
  const existing = node({ id: 'n-batch-fail', type: 'secret', label: 'Segreto fallback', content: 'Contenuto.' });
  const candidates = [
    nodeCandidate({ candidateId: 'cand-f1', targetType: 'secret', label: 'Segreto F1', content: 'Testo F1.' }),
    nodeCandidate({ candidateId: 'cand-f2', targetType: 'secret', label: 'Segreto F2', content: 'Testo F2.' }),
  ];
  let singleCalls = 0;
  const discrepancies = await buildSemanticDiscrepancies(candidates, {
    embedText: async () => {
      singleCalls++;
      return [0.1, 0.2, 0.3];
    },
    embedTexts: async () => {
      throw new Error('batch endpoint down');
    },
    semanticSearch: async () => [{ node: existing, score: 0.95 }],
  });

  assert.equal(singleCalls, 2);
  assert.equal(discrepancies.length, 2);
});

test('buildCanonDiscrepancyReport without semantic options behaves exactly like the lexical-only report', async () => {
  const candidate = nodeCandidate({ candidateId: 'cand-plain', targetType: 'secret', label: 'Segreto qualsiasi', content: 'Testo qualsiasi.' });
  const lexical = buildBibleDiscrepancyReport([candidate], [], []);
  const combined = await buildCanonDiscrepancyReport([candidate], [], []);
  assert.deepEqual(combined, lexical);
});

test('buildCanonDiscrepancyReport merges semantic discrepancies into the lexical report and recomputes blocking', async () => {
  const existing = node({ id: 'n-4', type: 'secret', label: 'Segreto originale', content: 'Il segreto originale.' });
  const candidate = nodeCandidate({ candidateId: 'cand-semantic', targetType: 'secret', label: 'Segreto riformulato', content: 'Testo riformulato senza parole in comune.' });

  const report = await buildCanonDiscrepancyReport([candidate], [existing], [], fakeSemanticOptions({ score: 0.99, matchNode: existing }));

  assert.equal(report.hasBlockingDiscrepancies, true);
  assert.ok(report.discrepancies.some((item) => item.code === 'possible_duplicate_or_alias_semantic'));
  assert.equal(report.summary.blocking, report.discrepancies.filter((item) => item.blocking).length);
});
