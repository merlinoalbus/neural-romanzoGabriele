import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embeddingRuntimeStatus } from '../services/embeddingService.js';
import { registerConsolidationTools } from './consolidation.js';
import { registerKnowledgeGraphTools } from './knowledgeGraph.js';
import { registerNovelBibleTools } from './novelBible.js';
import { registerNovelIngestionTools } from './novelIngestion.js';

function registeredTool(server: McpServer, name: string) {
  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools;
  const tool = tools?.[name];
  assert.ok(tool, `Missing registered tool ${name}`);
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

test('knowledge graph embedding tools are registered with correct safety annotations', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerKnowledgeGraphTools(server);

  const status = registeredTool(server, 'kg_embedding_status');
  const backfill = registeredTool(server, 'kg_backfill_embeddings');
  const semanticSearch = registeredTool(server, 'kg_semantic_search');

  assert.equal(status.annotations?.readOnlyHint, true);
  assert.equal(status.annotations?.destructiveHint, false);
  assert.equal(backfill.annotations?.readOnlyHint, false);
  assert.equal(backfill.annotations?.destructiveHint, false);
  assert.equal(backfill.annotations?.idempotentHint, true);
  assert.equal(semanticSearch.annotations?.readOnlyHint, true);
  assert.equal(semanticSearch.annotations?.destructiveHint, false);
});

test('bulk delete node tool is registered as destructive and idempotent', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerKnowledgeGraphTools(server);

  const bulkDelete = registeredTool(server, 'kg_delete_nodes');

  assert.equal(bulkDelete.annotations?.readOnlyHint, false);
  assert.equal(bulkDelete.annotations?.destructiveHint, true);
  assert.equal(bulkDelete.annotations?.idempotentHint, true);
  assert.equal(inputSchemaKeys(bulkDelete).includes('dryRun'), true);
});

test('dryRun is accepted only by the bulk delete node tool', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerKnowledgeGraphTools(server);
  registerNovelBibleTools(server);
  registerNovelIngestionTools(server);
  registerConsolidationTools(server);

  const tools = (server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools ?? {};
  const toolsWithDryRun = Object.entries(tools)
    .filter(([, tool]) => inputSchemaKeys(tool).includes('dryRun'))
    .map(([name]) => name)
    .sort();

  assert.deepEqual(toolsWithDryRun, ['kg_delete_nodes']);
});

test('embedding runtime tools fail clearly when provider is not configured', async (t: TestContext) => {
  if (embeddingRuntimeStatus().configured) {
    t.skip('Embeddings provider is configured in this environment.');
    return;
  }
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerKnowledgeGraphTools(server);

  const backfill = registeredTool(server, 'kg_backfill_embeddings');
  const search = registeredTool(server, 'kg_semantic_search');

  const backfillResponse = await backfill.handler!({});
  const searchResponse = await search.handler!({ query: 'Gabriele cerca la verita' });

  const backfillStructured = backfillResponse as { structuredContent?: { ok?: boolean; error?: { code?: string } } };
  const searchStructured = searchResponse as { structuredContent?: { ok?: boolean; error?: { code?: string } } };
  assert.equal(backfillStructured.structuredContent?.ok, false);
  assert.equal(backfillStructured.structuredContent?.error?.code, 'KG_EMBEDDINGS_NOT_CONFIGURED');
  assert.equal(searchStructured.structuredContent?.ok, false);
  assert.equal(searchStructured.structuredContent?.error?.code, 'KG_EMBEDDINGS_NOT_CONFIGURED');
});
