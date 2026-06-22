import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelBibleTools } from './novelBible.js';

function registeredTool(server: McpServer, name: string) {
  const tools = (server as unknown as { _registeredTools?: Record<string, { handler?: (input: unknown) => Promise<unknown> }> })._registeredTools;
  const tool = tools?.[name];
  assert.ok(tool?.handler, `Missing registered tool ${name}`);
  return tool;
}

test('novel_ingest_bible_sections dryRun plans sections without graph writes', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const tool = registeredTool(server, 'novel_ingest_bible_sections');

  const response = await tool.handler!({
    sourceId: 'bibbia-gabriele',
    dryRun: true,
    sections: [
      { sectionId: '1', heading: 'Logline', text: 'Testo logline.', order: 1, path: ['Logline'] },
      { sectionId: '1.1', heading: 'Tema', text: 'Testo tema.', order: 2, path: ['Logline', 'Tema'] },
    ],
  });

  const structured = response as { structuredContent?: Record<string, unknown> };
  assert.equal(structured.structuredContent?.ok, true);
  assert.equal(structured.structuredContent?.dryRun, true);
  assert.deepEqual(structured.structuredContent?.summary, {
    sourceId: 'bibbia-gabriele',
    sourceType: 'novel_bible',
    dryRun: true,
    sectionsReceived: 2,
    nodesPlanned: 3,
    edgesPlanned: 3,
    nodesWritten: 0,
    edgesWritten: 0,
  });
  assert.equal(Array.isArray(structured.structuredContent?.plannedSections), true);
});

test('novel_commit_bible_candidates dryRun validates inline candidates before graph writes', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const tool = registeredTool(server, 'novel_commit_bible_candidates');

  const response = await tool.handler!({
    dryRun: true,
    candidates: [
      {
        candidateId: 'candidate-theme-identita',
        candidateKind: 'node',
        targetType: 'theme',
        label: 'Identita',
        content: 'Tema identitario.',
        evidence: { sourceId: 'bibbia-gabriele', sectionKey: '2.3.1' },
        confidence: 0.82,
        rationale: 'Sezione tematica validata.',
        metadata: {},
      },
    ],
  });

  const structured = response as { structuredContent?: Record<string, unknown> };
  assert.equal(structured.structuredContent?.ok, true);
  assert.equal(structured.structuredContent?.dryRun, true);
  assert.deepEqual(structured.structuredContent?.summary, {
    dryRun: true,
    sectionsScanned: 0,
    candidatesPlanned: 1,
    candidatesWritten: 0,
    candidatesCommitted: 0,
    edgesCommitted: 0,
  });
});

test('novel_commit_bible_candidates rejects candidates without evidence', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const tool = registeredTool(server, 'novel_commit_bible_candidates');

  const response = await tool.handler!({
    dryRun: true,
    candidates: [
      {
        candidateId: 'candidate-invalid',
        candidateKind: 'node',
        targetType: 'theme',
        label: 'Identita',
        evidence: { sourceId: '', sectionKey: '' },
        confidence: 0.1,
        rationale: 'Invalid.',
        metadata: {},
      },
    ],
  });

  const structured = response as { structuredContent?: { ok?: boolean; error?: { code?: string; details?: Record<string, unknown> } } };
  assert.equal(structured.structuredContent?.ok, false);
  assert.equal(structured.structuredContent?.error?.code, 'NOVEL_COMMIT_CANDIDATES_INVALID');
  assert.match(JSON.stringify(structured.structuredContent?.error?.details), /missing_evidence_sourceId/);
});

test('novel bible coverage and context packet tools are registered as read-only', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const coverageTool = registeredTool(server, 'novel_bible_coverage_report') as { annotations?: Record<string, unknown> };
  const contextTool = registeredTool(server, 'novel_get_chapter_context_packet') as { annotations?: Record<string, unknown> };

  assert.equal(coverageTool.annotations?.readOnlyHint, true);
  assert.equal(contextTool.annotations?.readOnlyHint, true);
});
