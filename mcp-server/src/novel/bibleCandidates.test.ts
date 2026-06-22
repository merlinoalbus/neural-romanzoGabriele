import assert from 'node:assert/strict';
import test from 'node:test';
import { extractBibleCandidatesFromSection, validateBibleCandidateForCommit, type BibleCandidate } from './bibleCandidates.js';

test('extractBibleCandidatesFromSection creates non-canonical character candidates from dossier sections', () => {
  const candidates = extractBibleCandidatesFromSection({
    label: 'bibbia::3.1',
    content: 'Gabriele ha una voce fragile e un arco evolutivo centrale.',
    metadata: {
      sourceId: 'bibbia',
      sectionKey: '3.1',
      heading: 'Gabriele',
      path: ['Dossier dei Personaggi', 'Gabriele'],
      contentHash: 'hash-gabriele',
    },
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].candidateKind, 'node');
  assert.equal(candidates[0].targetType, 'character');
  assert.equal(candidates[0].label, 'Gabriele');
  assert.equal(candidates[0].evidence.sourceId, 'bibbia');
  assert.equal(candidates[0].evidence.sectionKey, '3.1');
  assert.equal(candidates[0].metadata.extractedHeading, 'Gabriele');
});

test('extractBibleCandidatesFromSection classifies timeline, worldbuilding, style and glossary sections', () => {
  const inputs = [
    { heading: 'Evento iniziale', path: ['Cronologia Dettagliata degli Eventi', 'Evento iniziale'], expected: 'timeline_event' },
    { heading: 'Regole degli Angeli', path: ['Ambientazione e Worldbuilding', 'Regole degli Angeli'], expected: 'world_rule' },
    { heading: 'Tono e POV', path: ['Stile', 'Tono e POV'], expected: 'style_rule' },
    { heading: 'Termine Sacro', path: ['Glossario', 'Termine Sacro'], expected: 'glossary_term' },
  ];

  for (const input of inputs) {
    const candidates = extractBibleCandidatesFromSection({
      label: `bibbia::${input.heading}`,
      content: 'Testo fonte.',
      metadata: { sourceId: 'bibbia', sectionKey: input.heading, heading: input.heading, path: input.path },
    });
    assert.equal(candidates[0]?.targetType, input.expected);
  }
});

test('validateBibleCandidateForCommit requires evidence and valid committable node target', () => {
  const candidate = {
    candidateId: 'c1',
    candidateKind: 'node',
    targetType: 'bible_candidate',
    label: '',
    evidence: { sourceId: '', sectionKey: '' },
    confidence: 0.5,
    rationale: 'bad',
    metadata: {},
  } as BibleCandidate;

  assert.deepEqual(validateBibleCandidateForCommit(candidate), [
    'missing_evidence_sourceId',
    'missing_evidence_sectionKey',
    'target_type_not_committable',
    'missing_label',
  ]);
});

test('validateBibleCandidateForCommit rejects non-canonical relation kinds', () => {
  const candidate = {
    candidateId: 'c2',
    candidateKind: 'edge',
    relationKind: 'invented_relation',
    from: { type: 'character', label: 'Gabriele' },
    to: { type: 'theme', label: 'Identita' },
    evidence: { sourceId: 'bibbia', sectionKey: '2.1' },
    confidence: 0.5,
    rationale: 'bad edge',
    metadata: {},
  } as BibleCandidate;

  assert.deepEqual(validateBibleCandidateForCommit(candidate), ['invalid_relation_kind']);
});

test('validateBibleCandidateForCommit accepts sourced canonical node and edge candidates', () => {
  const nodeCandidate = {
    candidateId: 'c3',
    candidateKind: 'node',
    targetType: 'theme',
    label: 'Identita',
    evidence: { sourceId: 'bibbia', sectionKey: '2.1' },
    confidence: 0.8,
    rationale: 'theme',
    metadata: {},
  } as BibleCandidate;
  const edgeCandidate = {
    candidateId: 'c4',
    candidateKind: 'edge',
    relationKind: 'has_theme',
    from: { type: 'character', label: 'Gabriele' },
    to: { type: 'theme', label: 'Identita' },
    evidence: { sourceId: 'bibbia', sectionKey: '2.1' },
    confidence: 0.8,
    rationale: 'edge',
    metadata: {},
  } as BibleCandidate;

  assert.deepEqual(validateBibleCandidateForCommit(nodeCandidate), []);
  assert.deepEqual(validateBibleCandidateForCommit(edgeCandidate), []);
});
