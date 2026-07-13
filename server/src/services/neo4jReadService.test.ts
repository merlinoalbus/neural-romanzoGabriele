import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueNumberedChapters,
  ChapterListIntegrityError,
  type ChapterSummary,
} from './neo4jReadService.js';

function chapter(id: string, number: number | null, label = id): ChapterSummary {
  return {
    id,
    label,
    number,
    title: label,
    date: null,
    timePlane: null,
    chapterKind: null,
    documentChapterLabel: null,
    primarySectionKey: null,
    frameOrder: null,
  };
}

test('chapter list accepts one structural node per numbered chapter and repeated bookends', () => {
  assert.doesNotThrow(() => assertUniqueNumberedChapters([
    chapter('prologo-a', null),
    chapter('prologo-b', null),
    chapter('chapter-1', 1, 'Vigilia di Scuola'),
    chapter('chapter-2', 2, 'La Legge del Corridoio'),
  ]));
});

test('chapter list exposes every duplicate numbered identity instead of hiding rows', () => {
  assert.throws(
    () => assertUniqueNumberedChapters([
      chapter('placeholder-2', 2, 'Capitolo 2'),
      chapter('canonical-1', 1, 'Vigilia di Scuola'),
      chapter('placeholder-1', 1, 'Capitolo 1'),
      chapter('canonical-2', 2, 'La Legge del Corridoio'),
    ]),
    (error: unknown) => error instanceof ChapterListIntegrityError
      && error.code === 'CHAPTER_IDENTITY_AMBIGUOUS'
      && JSON.stringify(error.duplicates) === JSON.stringify([
        { chapterNumber: 1, nodeIds: ['canonical-1', 'placeholder-1'] },
        { chapterNumber: 2, nodeIds: ['canonical-2', 'placeholder-2'] },
      ]),
  );
});
