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

test('extractBibleCandidatesFromSection supports section, atomic and family-filtered extraction', () => {
  const section = {
    label: 'bibbia::world',
    content: [
      'Il segreto resta nascosto fino al capitolo dopo.',
      'Gli occhiali sono un oggetto e un artefatto ricorrente.',
      'Il potere ha un costo e richiede controllo.',
      'La fazione dell Ordine conserva una profezia e una visione precognitiva.',
      'Il simbolo ricorrente mostra un motivo centrale.',
      'Gabriele vuole un obiettivo, crede in una convinzione e porta una ferita.',
      'Un tratto del carattere guida il temperamento.',
    ].join(' '),
    metadata: {
      sourceId: 'bibbia',
      sectionKey: 'world',
      heading: 'Regole e Segreti',
      path: ['Worldbuilding', 'Regole e Segreti'],
      contentHash: 'hash-world',
    },
  };

  const sectionOnly = extractBibleCandidatesFromSection(section, { granularity: 'section' });
  assert.deepEqual(sectionOnly.map((candidate) => candidate.targetType), ['world_rule']);

  const atomic = extractBibleCandidatesFromSection(section, { granularity: 'atomic' });
  const atomicTypes = new Set(atomic.map((candidate) => candidate.targetType));
  assert.equal(atomicTypes.has('bible_claim'), true);
  assert.equal(atomicTypes.has('secret'), true);
  assert.equal(atomicTypes.has('artifact'), true);
  assert.equal(atomicTypes.has('power'), true);
  assert.equal(atomicTypes.has('faction'), true);
  assert.equal(atomicTypes.has('prophecy'), true);
  assert.equal(atomicTypes.has('precognitive_data'), true);
  assert.equal(atomicTypes.has('symbol'), true);
  assert.equal(atomicTypes.has('motif'), true);
  assert.equal(atomicTypes.has('character_goal'), true);
  assert.equal(atomicTypes.has('character_belief'), true);
  assert.equal(atomicTypes.has('character_wound'), true);
  assert.equal(atomicTypes.has('character_trait'), true);

  const both = extractBibleCandidatesFromSection(section, { granularity: 'both' });
  assert.ok(both.length > atomic.length);
  assert.equal(both.some((candidate) => candidate.metadata.granularity === 'section'), true);
  assert.equal(both.some((candidate) => candidate.metadata.granularity === 'atomic'), true);

  const objectsOnly = extractBibleCandidatesFromSection(section, {
    granularity: 'atomic',
    families: ['objects_powers_factions'],
  });
  assert.deepEqual([...new Set(objectsOnly.map((candidate) => candidate.metadata.family))], ['objects_powers_factions']);
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

test('validateBibleCandidateForCommit requires snippets and content for atomic bible claims', () => {
  const candidate = {
    candidateId: 'claim-1',
    candidateKind: 'node',
    targetType: 'bible_claim',
    label: 'Gabriele non conosce il segreto',
    content: '',
    evidence: { sourceId: 'bibbia', sectionKey: '4.1' },
    confidence: 0.8,
    rationale: 'atomic claim',
    metadata: { granularity: 'atomic', family: 'knowledge_secrets' },
  } as BibleCandidate;

  assert.deepEqual(validateBibleCandidateForCommit(candidate), ['missing_atomic_textSnippet', 'missing_claim_content']);
});

test('validateBibleCandidateForCommit accepts new sourced canonical node types', () => {
  const candidate = {
    candidateId: 'artifact-1',
    candidateKind: 'node',
    targetType: 'artifact',
    label: 'Occhiali di Gabriele',
    content: 'Oggetto ricorrente legato alla percezione di Gabriele.',
    evidence: {
      sourceId: 'bibbia',
      sectionKey: '5.2',
      textSnippet: 'Gli occhiali segnano uno stato evolutivo.',
      path: ['Dossier dei Personaggi', 'Gabriele', 'Oggetti'],
      span: { startChar: 12, endChar: 58, paragraphIndex: 0 },
    },
    confidence: 0.8,
    rationale: 'artifact',
    metadata: { family: 'objects_powers_factions', granularity: 'atomic', extractionRule: 'test', requiresReview: true },
  } as BibleCandidate;

  assert.deepEqual(validateBibleCandidateForCommit(candidate), []);
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
