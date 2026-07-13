import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { config } from '../config.js';
import {
  createOrResumeEditingSession,
  deleteEditingSession,
  EditingSessionNotFoundError,
  finalizeEditingSession,
  readEditingSession,
  updateEditingSession,
  writeEditingSession,
} from './editingSessionStore.js';

test('editing session state is persisted to a file and never touches the graph', async () => {
  const sessionId = 'test-session-round-trip';
  await deleteEditingSession(sessionId); // in case a previous failed run left it behind
  try {
    const created = await createOrResumeEditingSession({ sessionId, chapterNumber: 7, title: 'Prova' });
    assert.equal(created.status, 'active');
    assert.equal(created.blocks.length, 0);
    assert.equal(created.findings.length, 0);
    assert.equal(created.workingDraftBaseline, null);

    const reread = await readEditingSession(sessionId);
    assert.deepEqual(reread.blocks, created.blocks);
    assert.equal(reread.chapterNumber, 7);
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('resuming an existing session preserves previously saved findings', async () => {
  const sessionId = 'test-session-resume';
  await deleteEditingSession(sessionId);
  try {
    const first = await createOrResumeEditingSession({ sessionId, chapterNumber: 3 });
    await writeEditingSession({
      ...first,
      findings: [
        {
          id: 'step1_continuity-GLOBAL-001',
          step: 'step1_continuity',
          category: 'continuity_red',
          severity: 'error',
          problem: 'Timeline inconsistency',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const resumed = await createOrResumeEditingSession({ sessionId, chapterNumber: 3 });
    assert.equal(resumed.findings.length, 1);
    assert.equal(resumed.findings[0].problem, 'Timeline inconsistency');
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('deleting a session removes the file so it can no longer be read', async () => {
  const sessionId = 'test-session-delete';
  await createOrResumeEditingSession({ sessionId, chapterNumber: 1 });
  await deleteEditingSession(sessionId);
  await assert.rejects(() => readEditingSession(sessionId), EditingSessionNotFoundError);
});

test('reading a session that never existed fails with EditingSessionNotFoundError, not a raw fs error', async () => {
  await assert.rejects(() => readEditingSession('test-session-never-existed'), EditingSessionNotFoundError);
});

test('session ids outside the safe charset are rejected (no path traversal)', async () => {
  await assert.rejects(() => readEditingSession('../../etc/passwd'), /invalid_session_id/);
  await assert.rejects(() => readEditingSession('with/slash'), /invalid_session_id/);
});

test('working draft baseline stores only immutable hash/count metadata, never another prose copy', async () => {
  const sessionId = 'test-session-working-baseline';
  await deleteEditingSession(sessionId);
  try {
    const created = await createOrResumeEditingSession({
      sessionId,
      chapterNumber: 2,
      baselineContent: 'Una baseline di quattro parole.',
    });
    const baseline = created.workingDraftBaseline;
    assert.ok(baseline);
    assert.match(baseline.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(baseline.wordCount, 5);
    assert.equal(baseline.charCount, 'Una baseline di quattro parole.'.length);
    assert.equal('content' in baseline, false);
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('updateEditingSession serializes read-modify-write operations against the freshest state', async () => {
  const sessionId = 'test-session-atomic-update';
  await deleteEditingSession(sessionId);
  try {
    await createOrResumeEditingSession({ sessionId, chapterNumber: 2 });
    await Promise.all([
      updateEditingSession(sessionId, (state) => ({ ...state, notes: `${state.notes ?? ''}A` })),
      updateEditingSession(sessionId, (state) => ({ ...state, notes: `${state.notes ?? ''}B` })),
    ]);
    const reread = await readEditingSession(sessionId);
    assert.equal(reread.notes, 'AB');
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('finalizeEditingSession keeps the session on a rejected finalization', async () => {
  const sessionId = 'test-session-finalize-rejected';
  await deleteEditingSession(sessionId);
  try {
    await createOrResumeEditingSession({ sessionId, chapterNumber: 2 });
    const value = await finalizeEditingSession(sessionId, async (state) => ({
      finalized: false,
      value: state.chapterNumber,
    }));
    assert.equal(value, 2);
    assert.equal((await readEditingSession(sessionId)).chapterNumber, 2);
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('finalizeEditingSession deletes under the mutex and queued mutations cannot recreate the session', async () => {
  const sessionId = 'test-session-finalize-serialized';
  await deleteEditingSession(sessionId);
  await createOrResumeEditingSession({ sessionId, chapterNumber: 2 });
  let enterFinalizer!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterFinalizer = resolve;
  });
  let releaseFinalizer!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFinalizer = resolve;
  });

  const finalization = finalizeEditingSession(sessionId, async () => {
    enterFinalizer();
    await release;
    return { finalized: true, value: 'done' };
  });
  await entered;
  const queuedMutation = updateEditingSession(sessionId, (state) => ({ ...state, notes: 'too late' }));
  releaseFinalizer();

  assert.equal(await finalization, 'done');
  await assert.rejects(queuedMutation, EditingSessionNotFoundError);
  await assert.rejects(() => readEditingSession(sessionId), EditingSessionNotFoundError);
});

test('reading legacy session JSON fills all fields introduced after the original schema', async () => {
  const sessionId = 'test-session-legacy-shape';
  await deleteEditingSession(sessionId);
  try {
    const directory = path.resolve(config.editingStateDir);
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(
      path.join(directory, `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        chapterNumber: 2,
        status: 'active',
        workingDraftRevisions: [{ revision: 1, content: 'Copia legacy da scartare.' }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      'utf8',
    );
    const state = await readEditingSession(sessionId);
    assert.deepEqual(state.blocks, []);
    assert.deepEqual(state.findings, []);
    assert.deepEqual(state.decisions, []);
    assert.deepEqual(state.rewrites, []);
    assert.equal(state.seamReview, null);
    assert.deepEqual(state.visualBriefs, []);
    assert.equal(state.assembledRevision, null);
    assert.equal(state.workingDraftBaseline, null);
    assert.equal('workingDraftRevisions' in state, false);
    const migratedOnDisk = JSON.parse(await readFile(path.join(directory, `${sessionId}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal('workingDraftRevisions' in migratedOnDisk, false);
  } finally {
    await deleteEditingSession(sessionId);
  }
});
