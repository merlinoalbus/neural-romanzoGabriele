import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBibleCoverageReport, buildChapterContextPacket } from './bibleCoverage.js';
import type { GraphEdge, GraphNode } from '../graph/neo4jStore.js';

function node(input: Partial<GraphNode> & { type: string; label: string }): GraphNode {
  return {
    id: input.id ?? `${input.type}-${input.label}`,
    type: input.type,
    label: input.label,
    content: input.content ?? '',
    metadata: input.metadata ?? {},
    provenance: input.provenance ?? {},
    createdAt: '',
    updatedAt: '',
  };
}

function edge(kind: string, metadata: Record<string, unknown> = {}): GraphEdge {
  return {
    id: `edge-${kind}`,
    fromId: 'a',
    toId: 'b',
    kind,
    weight: 1,
    metadata,
    provenance: {},
    createdAt: '',
  };
}

test('buildBibleCoverageReport reports unmapped sections, pending candidates and generic edges', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::3.1', metadata: { sourceId: 'bibbia', sectionKey: '3.1', heading: 'Gabriele', order: 1 } }),
      node({ type: 'bible_section', label: 'bibbia::4.1', metadata: { sourceId: 'bibbia', sectionKey: '4.1', heading: 'Regole', order: 2 } }),
    ],
    candidates: [
      node({
        type: 'bible_candidate',
        label: 'candidate-1',
        metadata: { status: 'pending', evidence: { sourceId: 'bibbia', sectionKey: '3.1' } },
      }),
    ],
    canonicalNodes: [node({ type: 'character', label: 'Lisa', metadata: { canonStatus: 'canonical' }, provenance: {} })],
    edges: [edge('related_to'), edge('has_theme')],
  });

  assert.equal(report.sectionCount, 2);
  assert.equal(report.pendingCandidates, 1);
  assert.equal(report.claimMappedSections, 0);
  assert.equal(report.canonicalNodeMappedSections, 0);
  assert.equal(report.canonicalEdgeMappedSections, 0);
  assert.deepEqual(report.unmappedSections.map((section) => section.sectionKey), ['4.1']);
  assert.deepEqual(report.nodesWithoutEvidence.map((item) => item.label), ['Lisa']);
  assert.equal(report.genericRelatedToEdges, 1);
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    'unmapped_bible_sections',
    'pending_bible_candidates',
    'canonical_nodes_without_evidence',
    'generic_related_to_edges',
  ]);
});

test('buildBibleCoverageReport distinguishes section-only, claim-only, duplicates and missing endpoints', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::1', metadata: { sourceId: 'bibbia', sectionKey: '1', heading: 'Sezione', order: 1 } }),
      node({ type: 'bible_section', label: 'bibbia::2', metadata: { sourceId: 'bibbia', sectionKey: '2', heading: 'Claim', order: 2 } }),
      node({ type: 'bible_section', label: 'bibbia::3', metadata: { sourceId: 'bibbia', sectionKey: '3', heading: 'Typed', order: 3 } }),
    ],
    candidates: [
      node({
        type: 'bible_candidate',
        label: 'candidate-section',
        metadata: {
          status: 'pending',
          targetType: 'world_rule',
          evidence: { sourceId: 'bibbia', sectionKey: '1' },
          candidate: { candidateKind: 'node', targetType: 'world_rule', metadata: { granularity: 'section' } },
        },
      }),
      node({
        type: 'bible_candidate',
        label: 'candidate-claim',
        metadata: {
          status: 'pending',
          targetType: 'bible_claim',
          evidence: { sourceId: 'bibbia', sectionKey: '2' },
          candidate: { candidateKind: 'node', targetType: 'bible_claim', metadata: { granularity: 'atomic' } },
        },
      }),
      node({
        type: 'bible_candidate',
        label: 'candidate-edge',
        metadata: {
          status: 'pending',
          candidateKind: 'edge',
          evidence: { sourceId: 'bibbia', sectionKey: '3' },
          candidate: {
            candidateKind: 'edge',
            from: { type: 'character', label: 'Missing' },
            to: { type: 'theme', label: 'Tema' },
          },
        },
      }),
    ],
    canonicalNodes: [
      node({ id: 'claim-1', type: 'bible_claim', label: 'Claim canonico', metadata: { canonStatus: 'canonical', evidence: { sourceId: 'bibbia', sectionKey: '2' } } }),
      node({ type: 'theme', label: 'Tema', metadata: { canonStatus: 'canonical', evidence: { sourceId: 'bibbia', sectionKey: '3' } } }),
      node({ type: 'theme', label: 'Tema', metadata: { canonStatus: 'canonical', evidence: { sourceId: 'bibbia', sectionKey: '3' } } }),
    ],
    edges: [],
  });

  assert.deepEqual(report.sectionMappedOnly.map((section) => section.sectionKey), ['1']);
  assert.deepEqual(report.claimMappedOnly.map((section) => section.sectionKey), ['2']);
  assert.equal(report.claimMappedSections, 1);
  assert.equal(report.canonicalNodeMappedSections, 1);
  assert.deepEqual(report.duplicateCanonicalNodes.map((item) => `${item.type}:${item.label}:${item.count}`), ['theme:Tema:2']);
  assert.deepEqual(report.untypedClaims.map((item) => item.label), ['Claim canonico']);
  assert.equal(report.pendingEdgeCandidatesWithMissingEndpoints.length, 1);
  assert.ok(report.findings.some((finding) => finding.code === 'section_mapped_only'));
  assert.ok(report.findings.some((finding) => finding.code === 'claim_mapped_only'));
  assert.ok(report.findings.some((finding) => finding.code === 'duplicate_canonical_nodes'));
  assert.ok(report.findings.some((finding) => finding.code === 'untyped_bible_claims'));
  assert.ok(report.findings.some((finding) => finding.code === 'pending_edge_candidates_missing_endpoints'));
});

test('buildBibleCoverageReport ignores cross-source evidence when sourceId is filtered', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia-a',
    sections: [
      node({ type: 'bible_section', label: 'bibbia-a::1', metadata: { sourceId: 'bibbia-a', sectionKey: '1', heading: 'Tema', order: 1 } }),
    ],
    candidates: [],
    canonicalNodes: [
      node({
        type: 'theme',
        label: 'Tema da altra fonte',
        metadata: { canonStatus: 'canonical', evidence: [{ sourceId: 'bibbia-b', sectionKey: '1' }] },
        provenance: {},
      }),
    ],
    edges: [],
  });

  assert.deepEqual(report.unmappedSections.map((section) => section.sectionKey), ['1']);
  assert.deepEqual(report.nodesWithoutEvidence.map((item) => item.label), ['Tema da altra fonte']);
});

test('buildBibleCoverageReport does not treat metadata.sourceId alone as evidence', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::1', metadata: { sourceId: 'bibbia', sectionKey: '1', heading: 'Tema', order: 1 } }),
    ],
    candidates: [],
    canonicalNodes: [node({ type: 'theme', label: 'Tema senza sezione', metadata: { sourceId: 'bibbia', canonStatus: 'canonical' }, provenance: {} })],
    edges: [],
  });

  assert.deepEqual(report.nodesWithoutEvidence.map((item) => item.label), ['Tema senza sezione']);
});

test('buildBibleCoverageReport accepts valid provenance or metadata sectionKey when metadata evidence is invalid', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::1', metadata: { sourceId: 'bibbia', sectionKey: '1', heading: 'Tema', order: 1 } }),
      node({ type: 'bible_section', label: 'bibbia::2', metadata: { sourceId: 'bibbia', sectionKey: '2', heading: 'Regola', order: 2 } }),
    ],
    candidates: [],
    canonicalNodes: [
      node({
        type: 'theme',
        label: 'Tema con provenance valida',
        metadata: { canonStatus: 'canonical', evidence: [{ sourceId: 'altra-bibbia', sectionKey: '1' }] },
        provenance: { sourceId: 'bibbia', sectionKey: '1' },
      }),
      node({
        type: 'world_rule',
        label: 'Regola con metadata sectionKey valida',
        metadata: { canonStatus: 'canonical', evidence: { sourceId: 'altra-bibbia', sectionKey: '2' }, sourceId: 'bibbia', sectionKey: '2' },
        provenance: {},
      }),
    ],
    edges: [],
  });

  assert.deepEqual(report.unmappedSections, []);
  assert.deepEqual(report.nodesWithoutEvidence, []);
});

test('buildBibleCoverageReport ignores draft editorial nodes when checking canonical evidence', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::1', metadata: { sourceId: 'bibbia', sectionKey: '1', heading: 'Tema', order: 1 } }),
    ],
    candidates: [],
    canonicalNodes: [
      node({ type: 'chapter', label: 'Capitolo 1', metadata: { sourceId: 'editing', canonStatus: 'draft' }, provenance: {} }),
      node({ type: 'theme', label: 'Tema canonico senza fonte', metadata: { canonStatus: 'canonical' }, provenance: {} }),
    ],
    edges: [],
  });

  assert.deepEqual(report.nodesWithoutEvidence.map((item) => item.label), ['Tema canonico senza fonte']);
});

test('buildBibleCoverageReport maps sections from edge evidence and coverage finding evidence', () => {
  const report = buildBibleCoverageReport({
    sourceId: 'bibbia',
    sections: [
      node({ type: 'bible_section', label: 'bibbia::1', metadata: { sourceId: 'bibbia', sectionKey: '1', heading: 'Tema', order: 1 } }),
      node({ type: 'bible_section', label: 'bibbia::2', metadata: { sourceId: 'bibbia', sectionKey: '2', heading: 'Relazione', order: 2 } }),
    ],
    candidates: [],
    canonicalNodes: [],
    coverageFindings: [
      node({
        type: 'bible_coverage_finding',
        label: 'edge-evidence',
        metadata: { sourceId: 'bibbia', sectionKey: '2', evidence: { sourceId: 'bibbia', sectionKey: '2' } },
      }),
    ],
    edges: [edge('has_theme', { evidence: { sourceId: 'bibbia', sectionKey: '1' } })],
  });

  assert.deepEqual(report.unmappedSections, []);
  assert.equal(report.mappedSections, 2);
});

test('buildChapterContextPacket groups context and carries coverage warnings', () => {
  const packet = buildChapterContextPacket({
    task: 'continuity',
    chapterNumber: 2,
    query: 'continuity Capitolo 2',
    nodes: [
      node({ type: 'chapter', label: 'Capitolo 2' }),
      node({ type: 'character', label: 'Gabriele' }),
      node({ type: 'world_rule', label: 'Regola Angeli' }),
      node({ type: 'chapter_draft', label: 'Draft', metadata: { status: 'draft' } }),
    ],
    includeDrafts: true,
    coverageReport: {
      sectionCount: 1,
      mappedSections: 0,
      claimMappedSections: 0,
      canonicalNodeMappedSections: 0,
      canonicalEdgeMappedSections: 0,
      unmappedSections: [{ sectionKey: '1', label: 'bibbia::1' }],
      sectionMappedOnly: [],
      claimMappedOnly: [],
      pendingCandidates: 0,
      nodesWithoutEvidence: [],
      genericRelatedToEdges: 0,
      duplicateCanonicalNodes: [],
      untypedClaims: [],
      pendingEdgeCandidatesWithMissingEndpoints: [],
      findings: [{ code: 'unmapped_bible_sections', severity: 'warning', message: 'warning' }],
    },
  });

  assert.equal(packet.chapterLabel, 'Capitolo 2');
  assert.equal(packet.counts.chapters, 1);
  assert.equal(packet.counts.characters, 1);
  assert.equal(packet.counts.worldRules, 1);
  assert.equal(packet.counts.drafts, 1);
  assert.deepEqual(packet.coverageWarnings.map((finding) => finding.code), ['unmapped_bible_sections']);
});
