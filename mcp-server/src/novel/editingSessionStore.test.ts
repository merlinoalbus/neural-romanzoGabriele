import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOrResumeEditingSession,
  deleteEditingSession,
  EditingSessionNotFoundError,
  readEditingSession,
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
