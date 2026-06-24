import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';
import type { BibleCandidate } from './bibleCandidates.js';
import { buildBibleDiscrepancyReport } from './bibleDiscrepancy.js';

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
