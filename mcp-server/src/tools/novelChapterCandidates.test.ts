import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelChapterCandidateTools } from './novelChapterCandidates.js';

test('chapter candidate pipeline tools are registered with correct read/write annotations', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelChapterCandidateTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools ?? {};

  const readOnly = ['novel_extract_chapter_candidates', 'novel_chapter_candidate_packet', 'novel_chapter_validation_packet', 'novel_chapter_postwrite_status'];
  for (const name of readOnly) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} should be read-only: it never writes to the graph`);
    assert.equal(tools[name].annotations?.destructiveHint, false);
  }

  const commit = tools['novel_commit_chapter_candidates'];
  assert.ok(commit, 'Missing tool novel_commit_chapter_candidates');
  assert.equal(commit.annotations?.readOnlyHint, false);
  assert.equal(commit.annotations?.destructiveHint, false);
});

test('novel_extract_chapter_candidates rejects empty content before touching the graph', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelChapterCandidateTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }> })._registeredTools ?? {};
  const extract = tools['novel_extract_chapter_candidates'];

  const response = (await extract.handler!({ chapterNumber: 1, content: '   ' })) as { structuredContent?: { ok?: boolean; error?: { code?: string } } };
  assert.equal(response.structuredContent?.ok, false);
  assert.equal(response.structuredContent?.error?.code, 'NOVEL_EXTRACT_CHAPTER_CANDIDATES_BAD_INPUT');
});

test('novel_extract_chapter_candidates requires either chapterNumber or role (Prologo/Epilogo covered too)', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelChapterCandidateTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }> })._registeredTools ?? {};
  const extract = tools['novel_extract_chapter_candidates'];

  const response = (await extract.handler!({ content: 'Un segreto nascosto.' })) as { structuredContent?: { ok?: boolean; error?: { code?: string } } };
  assert.equal(response.structuredContent?.ok, false);
  assert.equal(response.structuredContent?.error?.code, 'NOVEL_EXTRACT_CHAPTER_CANDIDATES_BAD_INPUT');
});

test('novel_commit_chapter_candidates rejects a candidate with missing evidence before touching the graph', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelChapterCandidateTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }> })._registeredTools ?? {};
  const commit = tools['novel_commit_chapter_candidates'];

  const response = (await commit.handler!({
    candidates: [
      {
        candidateId: 'chapter-candidate-bad',
        candidateKind: 'node',
        targetType: 'secret',
        label: 'Un segreto',
        content: 'Testo.',
        evidence: { sourceId: '', sectionKey: '' },
        confidence: 0.6,
        rationale: 'test',
        metadata: {},
      },
    ],
  })) as { structuredContent?: { ok?: boolean; error?: { code?: string; details?: unknown } } };

  assert.equal(response.structuredContent?.ok, false);
  assert.equal(response.structuredContent?.error?.code, 'NOVEL_COMMIT_CHAPTER_CANDIDATES_INVALID');
});
