import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelBibleTools } from './novelBible.js';

function registeredTool(server: McpServer, name: string) {
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools?.[name];
  assert.ok(tool?.handler, `Missing registered tool ${name}`);
  return tool;
}

type RegisteredTool = {
  annotations?: Record<string, unknown>;
  handler?: (input: unknown) => Promise<unknown>;
  inputSchema?: {
    def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) };
    _def?: { shape?: Record<string, unknown> | (() => Record<string, unknown>) };
  };
};

function inputSchemaKeys(tool: RegisteredTool): string[] {
  const shapeValue = tool.inputSchema?.def?.shape ?? tool.inputSchema?._def?.shape;
  const shape = typeof shapeValue === 'function' ? shapeValue() : shapeValue;
  return Object.keys(shape ?? {});
}

test('novel bible write tools do not expose dryRun inputs', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);

  for (const name of ['novel_ingest_bible_sections', 'novel_extract_bible_candidates', 'novel_commit_bible_candidates']) {
    const tool = registeredTool(server, name) as RegisteredTool;
    assert.equal(inputSchemaKeys(tool).includes('dryRun'), false, `${name} must not expose dryRun`);
    assert.equal(tool.annotations?.readOnlyHint, false, `${name} must be write-capable`);
  }
});

test('novel_commit_bible_candidates rejects candidates without evidence', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const tool = registeredTool(server, 'novel_commit_bible_candidates');

  const response = await tool.handler!({
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
  const ontologyTool = registeredTool(server, 'novel_get_bible_ontology') as { annotations?: Record<string, unknown> };
  const mappingTool = registeredTool(server, 'novel_get_bible_mapping_packet') as { annotations?: Record<string, unknown> };
  const coverageTool = registeredTool(server, 'novel_bible_coverage_report') as { annotations?: Record<string, unknown> };
  const paragraphStatusTool = registeredTool(server, 'novel_bible_paragraph_status') as { annotations?: Record<string, unknown> };
  const paragraphPacketTool = registeredTool(server, 'novel_bible_paragraph_reconciliation_packet') as { annotations?: Record<string, unknown> };
  const structuralClaimTool = registeredTool(server, 'novel_bible_structural_claim_packet') as { annotations?: Record<string, unknown> };
  const candidatePacketTool = registeredTool(server, 'novel_bible_candidate_packet') as { annotations?: Record<string, unknown> };
  const validationPacketTool = registeredTool(server, 'novel_bible_validation_packet') as { annotations?: Record<string, unknown> };
  const postwriteStatusTool = registeredTool(server, 'novel_bible_postwrite_status') as { annotations?: Record<string, unknown> };
  const progressEligibilityTool = registeredTool(server, 'novel_bible_progress_eligibility') as { annotations?: Record<string, unknown> };
  const checkpointSummaryTool = registeredTool(server, 'novel_bible_checkpoint_summary') as { annotations?: Record<string, unknown> };
  const contextTool = registeredTool(server, 'novel_get_chapter_context_packet') as { annotations?: Record<string, unknown> };

  assert.equal(ontologyTool.annotations?.readOnlyHint, true);
  assert.equal(mappingTool.annotations?.readOnlyHint, true);
  assert.equal(coverageTool.annotations?.readOnlyHint, true);
  assert.equal(paragraphStatusTool.annotations?.readOnlyHint, true);
  assert.equal(paragraphPacketTool.annotations?.readOnlyHint, true);
  assert.equal(structuralClaimTool.annotations?.readOnlyHint, true);
  assert.equal(candidatePacketTool.annotations?.readOnlyHint, true);
  assert.equal(validationPacketTool.annotations?.readOnlyHint, true);
  assert.equal(postwriteStatusTool.annotations?.readOnlyHint, true);
  assert.equal(progressEligibilityTool.annotations?.readOnlyHint, true);
  assert.equal(checkpointSummaryTool.annotations?.readOnlyHint, true);
  assert.equal(contextTool.annotations?.readOnlyHint, true);
});

test('novel bible paragraph-scoped tools expose scoped inputs', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);

  for (const name of [
    'novel_bible_paragraph_status',
    'novel_bible_paragraph_reconciliation_packet',
    'novel_bible_structural_claim_packet',
    'novel_bible_validation_packet',
    'novel_bible_postwrite_status',
    'novel_bible_progress_eligibility',
  ]) {
    const tool = registeredTool(server, name) as RegisteredTool;
    const keys = inputSchemaKeys(tool);
    assert.equal(keys.includes('sourceId'), true, `${name} must require sourceId`);
    assert.equal(keys.includes('sectionKey'), true, `${name} must require sectionKey`);
  }

  const candidatePacketTool = registeredTool(server, 'novel_bible_candidate_packet') as RegisteredTool;
  assert.deepEqual(inputSchemaKeys(candidatePacketTool).sort(), ['candidateId', 'sourceId']);
});

test('novel bible local packet implementation avoids global candidate scans', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./novelBible.ts', import.meta.url), 'utf8'));

  assert.equal(source.includes('listBibleCandidatesForSource(normalizedSourceId, 1000)'), false);
  assert.equal(source.includes('listBibleCandidatesForSource(sourceId, 1000)'), false);
  assert.equal(source.includes('kg.listBibleCandidatesBySection'), true);
  assert.equal(source.includes('kg.getBibleCandidateByIdOrLabel'), true);
});

test('novel bible paragraph status classifies header-only from pending candidates only', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./novelBible.ts', import.meta.url), 'utf8'));

  assert.equal(source.includes('pendingCandidates: kg.GraphNode[]'), true);
  assert.equal(source.includes('input.pendingCandidates.length === 0 && input.residualCanonicalClaims.length === 0'), true);
  assert.equal(source.includes('const pendingCandidates = candidates.filter(isPendingBibleCandidate);'), true);
  assert.equal(source.includes('const workItemsPendingCount = pendingCandidates.length + residualCanonicalClaims.length;'), true);
  assert.equal(source.includes('candidate_pending_count: pendingCandidates.length'), true);
  assert.equal(source.includes('workItemsPending_count: workItemsPendingCount'), true);
  assert.equal(source.includes("if (paragraphStatus === 'requires_claim_cleanup') blockingFindings.push('residual_canonical_claims_require_review');"), false);
});

test('novel_get_bible_ontology returns mapping contract without graph access', async () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelBibleTools(server);
  const tool = registeredTool(server, 'novel_get_bible_ontology');

  const response = await tool.handler!({});
  const structured = response as { structuredContent?: { ok?: boolean; readOnly?: boolean; ontology?: { nodeTypes?: string[]; relationKinds?: string[] } } };
  assert.equal(structured.structuredContent?.ok, true);
  assert.equal(structured.structuredContent?.readOnly, true);
  assert.equal(structured.structuredContent?.ontology?.nodeTypes?.includes('bible_claim'), true);
  assert.equal(structured.structuredContent?.ontology?.relationKinds?.includes('knows'), true);
});
