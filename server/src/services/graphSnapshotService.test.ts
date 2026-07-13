import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import neo4j from 'neo4j-driver';
import {
  snapshotNodeImportRow,
  type SnapshotGraphNode,
  validateWorkingDraftSnapshotNode,
  workingDraftSnapshotFieldsFromProperties,
} from './graphSnapshotService.js';

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
}

function node(content = 'Testo corrente'): SnapshotGraphNode {
  return {
    id: 'draft-002',
    type: 'chapter_draft',
    label: 'Capitolo 2 draft',
    content,
    metadata: {},
    provenance: {},
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-07-13T09:00:00.000Z',
  };
}

test('snapshot export preserves every working-draft operational field', () => {
  const fields = workingDraftSnapshotFieldsFromProperties({
    workingHistory: '[]',
    workingRevision: neo4j.int(7),
    workingContentHash: 'a'.repeat(64),
    workingUpdatedAt: '2026-07-13T09:00:00.000Z',
    workingUpdatedBy: 'user',
    lastWorkingMutationId: 'mutation-7',
    lastWorkingChangeSummary: 'Revisione del paragrafo iniziale',
    workingAuditStatus: 'passed',
    workingAuditContentHash: 'a'.repeat(64),
    workingAuditRevision: neo4j.int(7),
    workingAuditAt: '2026-07-13T09:05:00.000Z',
    workingAuditError: '',
  });

  assert.deepEqual(fields, {
    workingHistory: '[]',
    workingRevision: 7,
    workingContentHash: 'a'.repeat(64),
    workingUpdatedAt: '2026-07-13T09:00:00.000Z',
    workingUpdatedBy: 'user',
    lastWorkingMutationId: 'mutation-7',
    lastWorkingChangeSummary: 'Revisione del paragrafo iniziale',
    workingAuditStatus: 'passed',
    workingAuditContentHash: 'a'.repeat(64),
    workingAuditRevision: 7,
    workingAuditAt: '2026-07-13T09:05:00.000Z',
    workingAuditError: '',
  });
});

test('snapshot import restores operational fields with an integer revision', () => {
  const current = 'Versione corrente';
  const previous = 'Versione precedente';
  const source: SnapshotGraphNode = {
    ...node(current),
    workingHistory: JSON.stringify([{
      revision: 1,
      content: previous,
      contentHash: contentHash(previous),
    }]),
    workingRevision: 2,
    workingContentHash: contentHash(current).toUpperCase(),
    workingUpdatedAt: '2026-07-13T10:00:00.000Z',
    workingUpdatedBy: 'llm',
    lastWorkingMutationId: 'mutation-2',
    lastWorkingChangeSummary: 'Seconda versione',
    workingAuditStatus: 'passed',
    workingAuditContentHash: contentHash(current).toUpperCase(),
    workingAuditRevision: 2,
    workingAuditAt: '2026-07-13T10:05:00.000Z',
  };

  const row = snapshotNodeImportRow(source, 'fallback');
  assert.equal(row.workingHistory, source.workingHistory);
  assert.ok(neo4j.isInt(row.workingRevision));
  assert.equal((row.workingRevision as { toNumber(): number }).toNumber(), 2);
  assert.equal(row.workingContentHash, contentHash(current));
  assert.equal(row.workingUpdatedAt, source.workingUpdatedAt);
  assert.equal(row.workingUpdatedBy, source.workingUpdatedBy);
  assert.equal(row.lastWorkingMutationId, source.lastWorkingMutationId);
  assert.equal(row.lastWorkingChangeSummary, source.lastWorkingChangeSummary);
  assert.equal(row.workingAuditStatus, source.workingAuditStatus);
  assert.equal(row.workingAuditContentHash, contentHash(current));
  assert.ok(neo4j.isInt(row.workingAuditRevision));
  assert.equal((row.workingAuditRevision as { toNumber(): number }).toNumber(), 2);
  assert.equal(row.workingAuditAt, source.workingAuditAt);
});

test('snapshot import emits nulls for absent operational fields so upsert clears stale state', () => {
  const row = snapshotNodeImportRow(node(), 'fallback');

  assert.equal(row.workingHistory, null);
  assert.equal(row.workingRevision, null);
  assert.equal(row.workingContentHash, null);
  assert.equal(row.workingUpdatedAt, null);
  assert.equal(row.workingUpdatedBy, null);
  assert.equal(row.lastWorkingMutationId, null);
  assert.equal(row.lastWorkingChangeSummary, null);
  assert.equal(row.workingAuditStatus, null);
  assert.equal(row.workingAuditContentHash, null);
  assert.equal(row.workingAuditRevision, null);
  assert.equal(row.workingAuditAt, null);
  assert.equal(row.workingAuditError, null);
});

test('snapshot validation accepts coherent state and rejects content/hash or history mismatches', () => {
  const current = 'Versione corrente\r\ncon righe normalizzate';
  const previous = 'Versione precedente';
  const valid: SnapshotGraphNode = {
    ...node(current),
    workingRevision: 2,
    workingContentHash: contentHash(current),
    workingHistory: JSON.stringify([{
      revision: 1,
      content: previous,
      contentHash: contentHash(previous),
    }]),
    workingUpdatedBy: 'system',
    workingAuditStatus: 'passed',
    workingAuditContentHash: contentHash(current),
    workingAuditRevision: 2,
  };

  assert.deepEqual(validateWorkingDraftSnapshotNode(valid), []);
  assert.ok(validateWorkingDraftSnapshotNode({ ...valid, workingContentHash: '0'.repeat(64) })
    .includes('working_content_hash_mismatch'));
  assert.ok(validateWorkingDraftSnapshotNode({ ...valid, workingAuditRevision: 1 })
    .includes('working_audit_revision_mismatch'));
  assert.ok(validateWorkingDraftSnapshotNode({
    ...valid,
    workingHistory: JSON.stringify([{
      revision: 2,
      content: previous,
      contentHash: contentHash(previous),
    }]),
  }).includes('working_history_non_monotonic_revision_0'));
});
