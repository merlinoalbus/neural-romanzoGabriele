import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createOrResumeEditingSession,
  deleteEditingSession,
  readEditingSession,
  updateEditingSession,
} from '../novel/editingSessionStore.js';
import { ChapterIdentityAmbiguousError, type GraphNode } from '../graph/neo4jStore.js';
import { registerNovelEditingTools, rethrowChapterIdentityAmbiguity } from './novelEditing.js';

type RegisteredTool = {
  annotations?: Record<string, unknown>;
  handler?: (input: Record<string, unknown>) => Promise<unknown>;
};

function registeredEditingTools(): Record<string, RegisteredTool> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelEditingTools(server);
  return (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools ?? {};
}

function errorCode(response: unknown): string | undefined {
  return (response as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error?.code;
}

test('finalization retry preserves chapter number and duplicate IDs from an ambiguous identity', () => {
  const duplicate = (id: string): GraphNode => ({
    id,
    type: 'chapter',
    label: id,
    content: '',
    metadata: { chapterNumber: 1 },
    provenance: {},
    createdAt: '',
    updatedAt: '',
  });
  const ambiguity = new ChapterIdentityAmbiguousError(1, [duplicate('placeholder'), duplicate('canonical')]);
  assert.throws(
    () => rethrowChapterIdentityAmbiguity(ambiguity),
    (error: unknown) => error === ambiguity
      && ambiguity.chapterNumber === 1
      && ambiguity.nodeIds.join(',') === 'canonical,placeholder',
  );
  assert.doesNotThrow(() => rethrowChapterIdentityAmbiguity(new Error('transient lookup failure')));
});

test('novel editing workflow tools are registered as write-capable operational tools', () => {
  const tools = registeredEditingTools();
  const expected = [
    'novel_update_working_draft',
    'novel_start_editing_session',
    'novel_split_chapter_blocks',
    'novel_save_editorial_findings',
    'novel_save_user_decisions',
    'novel_save_rewrite_block',
    'novel_assemble_chapter_revision',
    'novel_save_seam_review',
    'novel_create_visual_brief',
    'novel_attach_generated_image',
  ];

  for (const name of expected) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, false);
    assert.equal(tools[name].annotations?.destructiveHint, false);
  }

  assert.ok(tools.novel_get_working_draft, 'Missing tool novel_get_working_draft');
  assert.equal(tools.novel_get_working_draft.annotations?.readOnlyHint, true);
  assert.equal(tools.novel_get_working_draft.annotations?.destructiveHint, false);

  assert.ok(tools.novel_save_final_chapter, 'Missing tool novel_save_final_chapter');
  assert.equal(tools.novel_save_final_chapter.annotations?.readOnlyHint, false);
  assert.equal(tools.novel_save_final_chapter.annotations?.destructiveHint, true);
});

test('final chapter refuses a session without an immutable baseline before touching the graph', async () => {
  const sessionId = 'test-final-missing-baseline';
  await deleteEditingSession(sessionId);
  try {
    await createOrResumeEditingSession({ sessionId, chapterNumber: 902, title: 'Test' });
    const response = await registeredEditingTools().novel_save_final_chapter.handler!({
      sessionId,
      chapterNumber: 902,
      content: 'Testo finale.',
    });
    assert.equal(errorCode(response), 'NOVEL_FINAL_BASELINE_MISSING');
    assert.equal((await readEditingSession(sessionId)).chapterNumber, 902);
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('final chapter refuses unresolved severity-error findings before touching the graph', async () => {
  const sessionId = 'test-final-open-errors';
  await deleteEditingSession(sessionId);
  try {
    await createOrResumeEditingSession({
      sessionId,
      chapterNumber: 903,
      title: 'Test',
      baselineContent: 'Testo finale.',
    });
    await updateEditingSession(sessionId, (state) => ({
      ...state,
      findings: [{
        id: 'step1_continuity-B01-001',
        step: 'step1_continuity',
        blockNumber: 1,
        category: 'continuity_red',
        severity: 'error',
        problem: 'Errore ancora aperto.',
        createdAt: new Date().toISOString(),
      }],
    }));
    const response = await registeredEditingTools().novel_save_final_chapter.handler!({
      sessionId,
      chapterNumber: 903,
      content: 'Testo finale.',
    });
    assert.equal(errorCode(response), 'NOVEL_FINAL_ERROR_FINDINGS_OPEN');
    assert.equal((await readEditingSession(sessionId)).findings.length, 1);
  } finally {
    await deleteEditingSession(sessionId);
  }
});

test('splitting a role section never replaces an already established baseline', async () => {
  const sessionId = 'test-split-preserves-baseline';
  await deleteEditingSession(sessionId);
  try {
    const created = await createOrResumeEditingSession({
      sessionId,
      role: 'prologo',
      title: 'Prologo',
      baselineContent: 'Baseline originale.',
    });
    const originalHash = created.workingDraftBaseline?.contentHash;
    const response = await registeredEditingTools().novel_split_chapter_blocks.handler!({
      sessionId,
      content: 'Testo completamente diverso.',
      persist: true,
      maxWords: 2500,
    });
    assert.equal((response as { structuredContent?: { ok?: boolean } }).structuredContent?.ok, true);
    const state = await readEditingSession(sessionId);
    assert.equal(state.workingDraftBaseline?.contentHash, originalHash);
    assert.equal(state.blocks.length, 1);
  } finally {
    await deleteEditingSession(sessionId);
  }
});
