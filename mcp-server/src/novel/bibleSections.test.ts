import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBibleSectionsPlan, previewBibleSection } from './bibleSections.js';

test('buildBibleSectionsPlan preserves hierarchy, order and full section text', () => {
  const plan = buildBibleSectionsPlan({
    sourceId: 'bibbia-gabriele',
    title: 'Bibbia del Romanzo',
    sections: [
      {
        sectionId: '3',
        heading: 'Dossier dei Personaggi',
        text: 'Sezione madre dei personaggi.',
        order: 1,
        level: 1,
        path: ['Dossier dei Personaggi'],
        headingStyle: 'Heading 1',
      },
      {
        sectionId: '3.1',
        parentSectionId: '3',
        heading: 'Gabriele',
        text: 'Testo integrale su Gabriele.\nCon dettagli di voce e arco.',
        order: 2,
        level: 2,
        path: ['Dossier dei Personaggi', 'Gabriele'],
        outlineNumber: '3.1',
      },
      {
        sectionId: '3.2',
        parentSectionId: '3',
        heading: 'Lisa',
        text: 'Testo integrale su Lisa.',
        order: 3,
        level: 2,
        path: ['Dossier dei Personaggi', 'Lisa'],
      },
    ],
  });

  assert.equal(plan.root.type, 'bible_outline');
  assert.equal(plan.sections.length, 3);
  assert.equal(plan.sections[1].content, 'Testo integrale su Gabriele.\nCon dettagli di voce e arco.');
  assert.equal(plan.sections[1].parentKey, '3');
  assert.equal(plan.sections[2].parentKey, '3');
  assert.equal(plan.edges.filter((edge) => edge.kind === 'part_of').length, 3);
  assert.deepEqual(
    plan.edges.filter((edge) => edge.kind === 'precedes').map((edge) => [edge.fromKey, edge.toKey]),
    [
      ['3', '3.1'],
      ['3.1', '3.2'],
    ],
  );
});

test('buildBibleSectionsPlan infers parent from heading path and creates deterministic previews', () => {
  const first = buildBibleSectionsPlan({
    sourceId: 'bibbia-gabriele',
    sections: [
      { heading: 'Cronologia', text: 'Radice timeline.', order: 10, path: ['Cronologia'] },
      { heading: 'Evento Uno', text: 'Evento causale.', order: 11, path: ['Cronologia', 'Evento Uno'] },
    ],
  });
  const second = buildBibleSectionsPlan({
    sourceId: 'bibbia-gabriele',
    sections: [
      { heading: 'Cronologia', text: 'Radice timeline.', order: 10, path: ['Cronologia'] },
      { heading: 'Evento Uno', text: 'Evento causale.', order: 11, path: ['Cronologia', 'Evento Uno'] },
    ],
  });

  assert.equal(first.sections[1].parentKey, first.sections[0].key);
  assert.equal(first.sections[0].key, second.sections[0].key);
  assert.equal(first.sections[1].metadata.contentHash, second.sections[1].metadata.contentHash);
  assert.deepEqual(previewBibleSection(first.sections[1]), {
    sectionKey: first.sections[1].key,
    label: first.sections[1].label,
    heading: 'Evento Uno',
    order: 11,
    level: 2,
    path: ['Cronologia', 'Evento Uno'],
    parentSectionKey: first.sections[0].key,
    contentHash: first.sections[1].metadata.contentHash,
    charCount: 15,
    wordCount: 2,
  });
});

test('buildBibleSectionsPlan rejects unsafe bible section payloads', () => {
  assert.throws(() => buildBibleSectionsPlan({ sourceId: '', sections: [] }), /sourceId/);
  assert.throws(
    () => buildBibleSectionsPlan({ sourceId: 'bibbia', sections: [{ heading: '', text: 'x', order: 1 }] }),
    /heading/,
  );
  assert.throws(
    () => buildBibleSectionsPlan({ sourceId: 'bibbia', sections: [{ heading: 'A', text: '', order: 1 }] }),
    /text/,
  );
  assert.throws(
    () =>
      buildBibleSectionsPlan({
        sourceId: 'bibbia',
        sections: [
          { sectionId: 'dup', heading: 'A', text: 'x', order: 1 },
          { sectionId: 'dup', heading: 'B', text: 'y', order: 2 },
        ],
      }),
    /duplicate section key/,
  );
});
