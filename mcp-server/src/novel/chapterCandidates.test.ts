import assert from 'node:assert/strict';
import test from 'node:test';
import { extractChapterCandidates } from './chapterCandidates.js';

test('extractChapterCandidates finds no candidates in prose with no matching keyword', () => {
  const candidates = extractChapterCandidates({
    sourceId: 'chapter-node-1',
    label: 'Capitolo 3',
    content: 'Il sole tramontava lentamente oltre la collina, tingendo il cielo di arancione.',
    sectionKey: 'full',
  });
  assert.equal(candidates.length, 0);
});

test('extractChapterCandidates tags a secret with evidence anchored to the chapter node', () => {
  const candidates = extractChapterCandidates({
    sourceId: 'chapter-node-12',
    label: 'Capitolo 12',
    content: 'Gabriele nasconde un segreto che nessuno dei suoi amici conosce ancora.',
    sectionKey: 'blocco-1',
  });

  const secret = candidates.find((candidate) => candidate.targetType === 'secret');
  assert.ok(secret, 'expected a secret candidate');
  assert.equal(secret!.candidateKind, 'node');
  assert.equal(secret!.evidence.sourceId, 'chapter-node-12');
  assert.equal(secret!.evidence.sectionKey, 'blocco-1');
  assert.equal(secret!.evidence.sectionLabel, 'Capitolo 12');
  assert.ok(secret!.evidence.textSnippet?.includes('segreto'));
  assert.equal(secret!.metadata.granularity, 'atomic');
});

test('extractChapterCandidates tags a location mention', () => {
  const candidates = extractChapterCandidates({
    sourceId: 'chapter-node-7',
    label: 'Capitolo 7',
    content: 'Entrarono nella vecchia casa abbandonata ai margini del bosco.',
    sectionKey: 'full',
  });
  assert.ok(candidates.some((candidate) => candidate.targetType === 'location'));
});

test('extractChapterCandidates defaults sectionKey to "full" when not given', () => {
  const candidates = extractChapterCandidates({
    sourceId: 'chapter-node-1',
    label: 'Prologo',
    content: 'Custodiva un segreto antico da generazioni.',
    sectionKey: '',
  });
  assert.equal(candidates[0]?.evidence.sectionKey, 'full');
});

test('extractChapterCandidates returns nothing for empty content or missing sourceId', () => {
  assert.equal(extractChapterCandidates({ sourceId: '', label: 'X', content: 'Un segreto nascosto.', sectionKey: 'full' }).length, 0);
  assert.equal(extractChapterCandidates({ sourceId: 'chapter-1', label: 'X', content: '   ', sectionKey: 'full' }).length, 0);
});

test('each candidate id is deterministic for the same chapter/section/type/label', () => {
  const chapter = { sourceId: 'chapter-node-9', label: 'Capitolo 9', content: 'Il segreto di Gabriele resta nascosto.', sectionKey: 'full' };
  const first = extractChapterCandidates(chapter);
  const second = extractChapterCandidates(chapter);
  assert.deepEqual(first.map((c) => c.candidateId), second.map((c) => c.candidateId));
});
