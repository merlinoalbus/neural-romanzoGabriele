import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertUniqueNumberedChapters,
  BookendIdentityAmbiguousError,
  ChapterListIntegrityError,
  composeNarrativeChapterList,
  type GraphNode,
  type ChapterSummary,
  UnclassifiedChapterIdentityError,
} from './neo4jReadService.js';
import { chapterListIntegrityHttpError } from '../routes/novel.js';

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

function node(id: string, label: string, metadata: Record<string, unknown> = {}): GraphNode {
  return { id, type: 'chapter', label, content: label, metadata, provenance: {}, createdAt: '', updatedAt: '' };
}

test('chapter list accepts one structural node per numbered chapter', () => {
  assert.doesNotThrow(() => assertUniqueNumberedChapters([
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

test('narrative list prefers the finalized role chapter and keeps its full metadata title', () => {
  const prologo = node('prologo-chapter', 'Prologo', {
    role: 'prologo',
    title: 'Prologo - La Promessa della Cioccolata Calda',
    canonStatus: 'canonical',
  });
  const fallback = { ...node('prologo-event', 'Prologo - evento'), type: 'timeline_event' };
  const result = composeNarrativeChapterList([
    node('chapter-2', 'La Legge del Corridoio', { chapterNumber: 2 }),
    prologo,
    node('chapter-1', 'Vigilia di Scuola', { chapterNumber: 1 }),
  ], [fallback], []);

  assert.deepEqual(result.map(({ id, role, number }) => ({ id, role, number })), [
    { id: 'prologo-chapter', role: 'prologo', number: null },
    { id: 'chapter-1', role: undefined, number: 1 },
    { id: 'chapter-2', role: undefined, number: 2 },
  ]);
  assert.equal(result[0].title, 'Prologo - La Promessa della Cioccolata Calda');
});

test('narrative list uses one legacy fallback and deduplicates repeated rows by node id', () => {
  const fallback = { ...node('prologo-event', 'Prologo - evento'), type: 'timeline_event' };
  const result = composeNarrativeChapterList(
    [node('chapter-1', 'Vigilia di Scuola', { chapterNumber: 1 })],
    [fallback, { ...fallback }],
    [],
  );
  assert.deepEqual(result.map(({ id }) => id), ['prologo-event', 'chapter-1']);
});

test('narrative list rejects ambiguous role chapters and distinct legacy fallbacks', () => {
  assert.throws(
    () => composeNarrativeChapterList([
      node('prologo-a', 'Prologo A', { role: 'prologo' }),
      node('prologo-b', 'Prologo B', { role: 'prologo' }),
    ], [], []),
    (error: unknown) => error instanceof BookendIdentityAmbiguousError
      && error.candidateKind === 'chapter'
      && JSON.stringify(error.nodeIds) === JSON.stringify(['prologo-a', 'prologo-b']),
  );
  assert.throws(
    () => composeNarrativeChapterList([], [
      { ...node('event-a', 'Prologo A'), type: 'timeline_event' },
      { ...node('event-b', 'Prologo B'), type: 'timeline_event' },
    ], []),
    (error: unknown) => error instanceof BookendIdentityAmbiguousError
      && error.candidateKind === 'fallback',
  );
});

test('narrative list rejects chapter nodes with neither a number nor a valid role', () => {
  assert.throws(
    () => composeNarrativeChapterList([node('unknown', 'Senza identita')], [], []),
    (error: unknown) => error instanceof UnclassifiedChapterIdentityError
      && JSON.stringify(error.nodeIds) === JSON.stringify(['unknown']),
  );
  assert.throws(
    () => composeNarrativeChapterList([node('invalid-role', 'Altro', { role: 'introduzione' })], [], []),
    UnclassifiedChapterIdentityError,
  );
});

test('chapter list integrity HTTP mapping preserves numeric payload and exposes typed bookend fields', () => {
  const numeric = new ChapterListIntegrityError([{ chapterNumber: 2, nodeIds: ['b', 'a'] }]);
  assert.deepEqual(chapterListIntegrityHttpError(numeric), {
    status: 409,
    error: { code: numeric.code, message: numeric.message, duplicates: [{ chapterNumber: 2, nodeIds: ['a', 'b'] }] },
  });
  const bookend = new BookendIdentityAmbiguousError('prologo', 'fallback', ['b', 'a']);
  assert.deepEqual(chapterListIntegrityHttpError(bookend), {
    status: 409,
    error: {
      code: bookend.code,
      message: bookend.message,
      role: 'prologo',
      candidateKind: 'fallback',
      nodeIds: ['a', 'b'],
    },
  });
  const unclassified = new UnclassifiedChapterIdentityError(['z']);
  assert.deepEqual(chapterListIntegrityHttpError(unclassified), {
    status: 409,
    error: { code: unclassified.code, message: unclassified.message, nodeIds: ['z'] },
  });
  assert.equal(chapterListIntegrityHttpError(new Error('other')), null);
});
