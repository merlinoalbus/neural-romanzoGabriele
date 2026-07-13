import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKING_DRAFT_RETAINED_HISTORY_LIMIT,
  WORKING_DRAFT_VERSION_LIMIT,
  checkWorkingDraftLength,
  decideWorkingDraftCas,
  isWorkingDraftAuditCurrent,
  normalizeWorkingDraftContent,
  retainWorkingDraftHistory,
  workingDraftContentHash,
  type WorkingDraftHistoryEntry,
} from './workingDraft.js';

function revision(revisionNumber: number): WorkingDraftHistoryEntry {
  const content = `Versione ${revisionNumber}`;
  return {
    revision: revisionNumber,
    content,
    contentHash: workingDraftContentHash(content),
    wordCount: 2,
    charCount: content.length,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, revisionNumber)).toISOString(),
    updatedBy: 'user',
    clientMutationId: `mutation-${revisionNumber}`,
  };
}

test('normalizes CRLF and lone CR without otherwise rewriting the draft', () => {
  assert.equal(normalizeWorkingDraftContent('uno\r\ndue\rtre\n'), 'uno\ndue\ntre\n');
  assert.equal(normalizeWorkingDraftContent('  testo con spazi  '), '  testo con spazi  ');
});

test('content hash is a normalized 64-character SHA-256 hex digest', () => {
  const hash = workingDraftContentHash('prima riga\r\nseconda riga');

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.length, 64);
  assert.equal(hash, workingDraftContentHash('prima riga\nseconda riga'));
  assert.notEqual(hash, workingDraftContentHash('prima riga\nseconda riga modificata'));
});

test('length gate accepts the inclusive 85%-140% boundaries', () => {
  assert.equal(checkWorkingDraftLength(100, 'parola '.repeat(85)).valid, true);
  assert.equal(checkWorkingDraftLength(100, 'parola '.repeat(140)).valid, true);
  assert.equal(checkWorkingDraftLength(100, 'parola '.repeat(84)).valid, false);
  assert.equal(checkWorkingDraftLength(100, 'parola '.repeat(141)).valid, false);
});

test('length gate rounds inward and handles an empty baseline deterministically', () => {
  const rounded = checkWorkingDraftLength(3, 'uno due tre quattro');
  assert.deepEqual(
    {
      baselineWords: rounded.baselineWords,
      currentWords: rounded.currentWords,
      minWords: rounded.minWords,
      maxWords: rounded.maxWords,
      valid: rounded.valid,
    },
    { baselineWords: 3, currentWords: 4, minWords: 3, maxWords: 4, valid: true },
  );
  assert.equal(checkWorkingDraftLength(3, 'uno due').valid, false);
  assert.equal(checkWorkingDraftLength(3, 'uno due tre quattro cinque').valid, false);
  assert.equal(checkWorkingDraftLength(0, '').valid, true);
  assert.equal(checkWorkingDraftLength(0, 'testo').valid, false);
});

test('retention keeps 19 previous revisions so current plus history never exceeds 20', () => {
  const history = Array.from({ length: 25 }, (_value, index) => revision(index + 1));
  const retained = retainWorkingDraftHistory(history);

  assert.equal(WORKING_DRAFT_VERSION_LIMIT, 20);
  assert.equal(WORKING_DRAFT_RETAINED_HISTORY_LIMIT, 19);
  assert.equal(retained.length, 19);
  assert.deepEqual(retained.map((item) => item.revision), Array.from({ length: 19 }, (_value, index) => index + 7));
  assert.equal(history.length, 25);
  assert.deepEqual(history.map((item) => item.revision), Array.from({ length: 25 }, (_value, index) => index + 1));
});

test('retention preserves previous-version archives at or below the limit and accepts an empty history', () => {
  const history = Array.from({ length: WORKING_DRAFT_RETAINED_HISTORY_LIMIT }, (_value, index) => revision(index + 1));

  assert.deepEqual(retainWorkingDraftHistory(history), history);
  assert.deepEqual(retainWorkingDraftHistory([]), []);
});

test('revision plus hash rejects the conceptual ABA case that a hash-only check would miss', () => {
  const initial = { revision: 7, contentHash: workingDraftContentHash('A') };
  const intermediate = { revision: 8, contentHash: workingDraftContentHash('B') };
  const returnedToA = { revision: 9, contentHash: workingDraftContentHash('A') };

  assert.notEqual(intermediate.contentHash, initial.contentHash);
  assert.equal(returnedToA.contentHash, initial.contentHash, 'the content hash alone cannot distinguish A -> B -> A');
  assert.notEqual(returnedToA.revision, initial.revision);
  assert.equal(
    returnedToA.contentHash === initial.contentHash && returnedToA.revision === initial.revision,
    false,
    'CAS must compare both the expected hash and the expected revision',
  );
});

test('CAS decision accepts an exact base or direct retry but rejects stale force and ABA writes', () => {
  const currentContentHash = workingDraftContentHash('corrente');
  const proposedContentHash = workingDraftContentHash('locale');
  const base = {
    currentContentHash,
    currentRevision: 12,
    lastMutationId: 'mutation-12',
    proposedContentHash,
    expectedContentHash: currentContentHash,
    expectedRevision: 12,
  };
  assert.equal(decideWorkingDraftCas(base), 'update');
  assert.equal(decideWorkingDraftCas({ ...base, expectedContentHash: currentContentHash.toUpperCase() }), 'update');
  assert.equal(decideWorkingDraftCas({ ...base, proposedContentHash: currentContentHash }), 'unchanged');
  assert.equal(decideWorkingDraftCas({ ...base, expectedRevision: 11 }), 'conflict');
  assert.equal(decideWorkingDraftCas({
    ...base,
    proposedContentHash: currentContentHash,
    expectedRevision: 11,
    clientMutationId: 'mutation-12',
  }), 'unchanged');
  assert.equal(decideWorkingDraftCas({
    ...base,
    proposedContentHash: currentContentHash,
    expectedRevision: 11,
    clientMutationId: 'different-mutation',
  }), 'conflict');
});

test('an audit is current only when status, full hash and monotonic revision all match', () => {
  const contentHash = workingDraftContentHash('testo corrente');
  const current = {
    auditStatus: 'passed' as const,
    auditContentHash: contentHash,
    auditRevision: 8,
    contentHash,
    revision: 8,
  };
  assert.equal(isWorkingDraftAuditCurrent(current), true);
  assert.equal(isWorkingDraftAuditCurrent({ ...current, auditContentHash: contentHash.toUpperCase() }), true);
  assert.equal(isWorkingDraftAuditCurrent({ ...current, auditStatus: 'pending' }), false);
  assert.equal(isWorkingDraftAuditCurrent({ ...current, auditContentHash: workingDraftContentHash('altro') }), false);
  assert.equal(isWorkingDraftAuditCurrent({ ...current, auditRevision: 7 }), false);
});
