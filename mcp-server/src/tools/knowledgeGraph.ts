import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { KG_KINDS_LIST } from '../graph/ontology.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

const jsonObj = z.record(z.string(), z.unknown());

const nodeZ = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  content: z.string(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const edgeZ = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
});

const assetZ = z.object({
  id: z.string(),
  nodeId: z.string(),
  path: z.string(),
  mime: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

const nodeInputZ = z.object({
  type: z.string(),
  label: z.string(),
  content: z.string().optional(),
  metadata: jsonObj.optional(),
  provenance: jsonObj.optional(),
});

const edgeInputZ = z.object({
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number().optional(),
  metadata: jsonObj.optional(),
  provenance: jsonObj.optional(),
});

const bulkSummaryZ = z.object({
  received: z.number(),
  created: z.number(),
  merged: z.number(),
  failed: z.number(),
  dryRun: z.boolean(),
});

const bulkNodeResultZ = z.object({
  type: z.string(),
  label: z.string(),
  status: z.enum(['created', 'merged', 'failed']),
  nodeId: z.string().optional(),
  reason: z.string().optional(),
});

const bulkEdgeResultZ = z.object({
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  status: z.enum(['created', 'merged', 'failed']),
  edgeId: z.string().optional(),
  reason: z.string().optional(),
});

const statsShape = {
  ok: z.boolean(),
  nodes: z.number(),
  edges: z.number(),
  nodeTypes: z.record(z.string(), z.number()),
  edgeKinds: z.record(z.string(), z.number()),
};

export function registerKnowledgeGraphTools(server: McpServer): void {
  server.registerTool(
    'kg_add_node',
    {
      title: 'KG add node',
      description: 'Creates a new graph node. Fails if the same type+label already exists in this project.',
      inputSchema: nodeInputZ.shape,
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), error: errorObj },
      annotations: { title: 'KG add node', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return toolStructured({ ok: true, node: await kg.addNode(input) });
      } catch (err) {
        return toolError('KG_ADD_NODE_FAILED', `kg_add_node failed: ${String(err)}`, { type: input.type, label: input.label });
      }
    },
  );

  server.registerTool(
    'kg_upsert_node',
    {
      title: 'KG upsert node',
      description: 'Creates or merges a node by type+label. Metadata/provenance objects are merged; arrays are unioned by value.',
      inputSchema: nodeInputZ.shape,
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), created: z.boolean().optional(), error: errorObj },
      annotations: { title: 'KG upsert node', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const { node, created } = await kg.upsertNode(input);
        return toolStructured({ ok: true, node, created });
      } catch (err) {
        return toolError('KG_UPSERT_NODE_FAILED', `kg_upsert_node failed: ${String(err)}`, { type: input.type, label: input.label });
      }
    },
  );

  server.registerTool(
    'kg_upsert_nodes',
    {
      title: 'KG upsert nodes bulk',
      description: 'Creates or merges many nodes. Use dryRun=true to validate without writing.',
      inputSchema: {
        nodes: z.array(nodeInputZ).min(1).max(1000),
        continueOnError: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), summary: bulkSummaryZ.optional(), results: z.array(bulkNodeResultZ).optional(), error: errorObj },
      annotations: { title: 'KG upsert nodes bulk', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nodes, continueOnError, dryRun }) => {
      try {
        const { summary, results } = await kg.upsertNodes(nodes, { continueOnError, dryRun });
        return toolStructured({ ok: true, summary, results });
      } catch (err) {
        return toolError('KG_UPSERT_NODES_FAILED', `kg_upsert_nodes failed: ${String(err)}`, { count: nodes.length });
      }
    },
  );

  server.registerTool(
    'kg_update_node',
    {
      title: 'KG update node',
      description: 'Updates a node by id. Metadata/provenance are merged; arrays are unioned by value.',
      inputSchema: {
        id: z.string(),
        type: z.string().optional(),
        label: z.string().optional(),
        content: z.string().optional(),
        metadata: jsonObj.optional(),
        provenance: jsonObj.optional(),
      },
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), error: errorObj },
      annotations: { title: 'KG update node', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, ...patch }) => {
      try {
        const node = await kg.updateNode(id, patch);
        if (!node) return toolError('KG_NODE_NOT_FOUND', `Node not found: ${id}`, { id });
        return toolStructured({ ok: true, node });
      } catch (err) {
        return toolError('KG_UPDATE_NODE_FAILED', `kg_update_node failed: ${String(err)}`, { id });
      }
    },
  );

  server.registerTool(
    'kg_delete_node',
    {
      title: 'KG delete node',
      description: 'Deletes a node by id and detaches connected relationships. Destructive.',
      inputSchema: { id: z.string() },
      outputSchema: { ok: z.boolean(), deleted: z.boolean(), error: errorObj },
      annotations: { title: 'KG delete node', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        return toolStructured({ ok: true, deleted: await kg.deleteNode(id) });
      } catch (err) {
        return toolError('KG_DELETE_NODE_FAILED', `kg_delete_node failed: ${String(err)}`, { id });
      }
    },
  );

  server.registerTool(
    'kg_link',
    {
      title: 'KG link',
      description: `Creates or merges a directed edge between existing nodes. kind must be one of: ${KG_KINDS_LIST.join(', ')}.`,
      inputSchema: edgeInputZ.shape,
      outputSchema: { ok: z.boolean(), edge: edgeZ.optional(), error: errorObj },
      annotations: { title: 'KG link', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return toolStructured({ ok: true, edge: await kg.link(input) });
      } catch (err) {
        return toolError('KG_LINK_FAILED', `kg_link failed: ${String(err)}`, { fromId: input.fromId, toId: input.toId, kind: input.kind });
      }
    },
  );

  server.registerTool(
    'kg_link_bulk',
    {
      title: 'KG link bulk',
      description: 'Creates or merges many directed edges. Use dryRun=true to validate nodes and relation kinds without writing.',
      inputSchema: {
        edges: z.array(edgeInputZ).min(1).max(1000),
        continueOnError: z.boolean().optional(),
        dryRun: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), summary: bulkSummaryZ.optional(), results: z.array(bulkEdgeResultZ).optional(), error: errorObj },
      annotations: { title: 'KG link bulk', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ edges, continueOnError, dryRun }) => {
      try {
        const { summary, results } = await kg.linkBulk(edges, { continueOnError, dryRun });
        return toolStructured({ ok: true, summary, results });
      } catch (err) {
        return toolError('KG_LINK_BULK_FAILED', `kg_link_bulk failed: ${String(err)}`, { count: edges.length });
      }
    },
  );

  server.registerTool(
    'kg_unlink',
    {
      title: 'KG unlink',
      description: 'Deletes an edge by edgeId, or by fromId+toId+kind. Destructive.',
      inputSchema: { edgeId: z.string().optional(), fromId: z.string().optional(), toId: z.string().optional(), kind: z.string().optional() },
      outputSchema: { ok: z.boolean(), deleted: z.boolean(), error: errorObj },
      annotations: { title: 'KG unlink', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ edgeId, fromId, toId, kind }) => {
      try {
        if (edgeId) return toolStructured({ ok: true, deleted: await kg.unlinkById(edgeId) });
        if (fromId && toId && kind) return toolStructured({ ok: true, deleted: await kg.unlink(fromId, toId, kind) });
        return toolError('KG_UNLINK_BAD_INPUT', 'Provide edgeId, or fromId+toId+kind.');
      } catch (err) {
        return toolError('KG_UNLINK_FAILED', `kg_unlink failed: ${String(err)}`, { edgeId, fromId, toId, kind });
      }
    },
  );

  server.registerTool(
    'kg_attach_asset',
    {
      title: 'KG attach asset',
      description: 'Registers a file path already present on the data volume and attaches it to a node.',
      inputSchema: { nodeId: z.string(), path: z.string(), mime: z.string().optional(), label: z.string().optional() },
      outputSchema: { ok: z.boolean(), asset: assetZ.optional(), error: errorObj },
      annotations: { title: 'KG attach asset', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nodeId, path, mime, label }) => {
      try {
        return toolStructured({ ok: true, asset: await kg.attachAsset(nodeId, { path, mime, label }) });
      } catch (err) {
        return toolError('KG_ATTACH_ASSET_FAILED', `kg_attach_asset failed: ${String(err)}`, { nodeId, path });
      }
    },
  );

  server.registerTool(
    'kg_get_node',
    {
      title: 'KG get node',
      description: 'Returns one node by id or by type+label, including attached assets.',
      inputSchema: { id: z.string().optional(), type: z.string().optional(), label: z.string().optional() },
      outputSchema: { ok: z.boolean(), node: nodeZ.nullable().optional(), assets: z.array(assetZ).optional(), error: errorObj },
      annotations: { title: 'KG get node', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, type, label }) => {
      try {
        const node = id ? await kg.getNodeById(id) : type && label ? await kg.getNodeByTypeLabel(type, label) : null;
        if (!node) return toolStructured({ ok: true, node: null, assets: [] });
        return toolStructured({ ok: true, node, assets: await kg.getAssets(node.id) });
      } catch (err) {
        return toolError('KG_GET_NODE_FAILED', `kg_get_node failed: ${String(err)}`, { id, type, label });
      }
    },
  );

  server.registerTool(
    'kg_search',
    {
      title: 'KG search',
      description: 'Full-text search on node label and content. Optional type filter.',
      inputSchema: { query: z.string(), type: z.string().optional(), limit: z.number().int().positive().optional() },
      outputSchema: { ok: z.boolean(), nodes: z.array(nodeZ) },
      annotations: { title: 'KG search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, type, limit }) => toolStructured({ ok: true, nodes: await kg.search(query, { type, limit }) }),
  );

  server.registerTool(
    'kg_neighbors',
    {
      title: 'KG neighbors',
      description: 'Returns the connected subgraph around a node up to a bounded depth.',
      inputSchema: { nodeId: z.string(), depth: z.number().int().positive().optional(), kinds: z.array(z.string()).optional() },
      outputSchema: { ok: z.boolean(), nodes: z.array(nodeZ), edges: z.array(edgeZ) },
      annotations: { title: 'KG neighbors', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nodeId, depth, kinds }) => {
      const graph = await kg.neighbors(nodeId, { depth, kinds });
      return toolStructured({ ok: true, ...graph });
    },
  );

  server.registerTool(
    'kg_recall',
    {
      title: 'KG recall',
      description: 'Searches relevant nodes and expands their neighborhood as ready-to-use context.',
      inputSchema: { query: z.string(), depth: z.number().int().positive().optional(), limit: z.number().int().positive().optional() },
      outputSchema: { ok: z.boolean(), matched: z.array(nodeZ), nodes: z.array(nodeZ), edges: z.array(edgeZ) },
      annotations: { title: 'KG recall', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, depth, limit }) => toolStructured({ ok: true, ...(await kg.recall(query, { depth, limit })) }),
  );

  server.registerTool(
    'kg_stats',
    {
      title: 'KG stats',
      description: 'Returns node/edge counts and distributions by type/kind.',
      inputSchema: {},
      outputSchema: statsShape,
      annotations: { title: 'KG stats', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolStructured({ ok: true, ...(await kg.stats()) }),
  );

  server.registerTool(
    'kg_audit_global',
    {
      title: 'KG audit global',
      description: 'Read-only hygiene audit for the current project graph.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        audit: z.object({
          nodes: z.number(),
          edges: z.number(),
          documents: z.number(),
          chunks: z.number(),
          assets: z.number(),
          orphanNodes: z.number(),
          orphanAssets: z.number(),
          relatedToTotal: z.number(),
          redundantRelatedTo: z.number(),
          nonCanonicalKinds: z.array(z.object({ kind: z.string(), count: z.number() })),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'KG audit global', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toolStructured({ ok: true, audit: await kg.auditGlobal() });
      } catch (err) {
        return toolError('KG_AUDIT_GLOBAL_FAILED', `kg_audit_global failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'kg_repair',
    {
      title: 'KG repair',
      description: 'Deterministic graph cleanup. Dry-run by default; pass dryRun=false to apply.',
      inputSchema: { dryRun: z.boolean().optional() },
      outputSchema: {
        ok: z.boolean(),
        dryRun: z.boolean().optional(),
        redundantRelatedToRetired: z.number().optional(),
        junkEdgesRemoved: z.number().optional(),
        orphanAssetsRemoved: z.number().optional(),
        error: errorObj,
      },
      annotations: { title: 'KG repair', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ dryRun }) => {
      try {
        return toolStructured({ ok: true, ...(await kg.repair({ dryRun })) });
      } catch (err) {
        return toolError('KG_REPAIR_FAILED', `kg_repair failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'kg_ingest_document',
    {
      title: 'KG ingest document',
      description: 'Registers a source document and ordered text chunks. This preserves raw material before semantic extraction.',
      inputSchema: {
        sourceId: z.string(),
        title: z.string().optional(),
        sourceType: z.string().optional(),
        content: z.string().optional(),
        chunks: z.array(z.object({ order: z.number().int().positive().optional(), text: z.string(), label: z.string().optional(), metadata: jsonObj.optional() })).optional(),
        chunkSize: z.number().int().positive().optional(),
        metadata: jsonObj.optional(),
        provenance: jsonObj.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        document: nodeZ.optional(),
        chunks: z.array(nodeZ).optional(),
        created: z.boolean().optional(),
        chunkCount: z.number().optional(),
        nas: z.object({
          saved: z.boolean(),
          path: z.string().optional(),
          metadataPath: z.string().optional(),
          bytes: z.number().optional(),
          error: z.string().optional(),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'KG ingest document', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return toolStructured({ ok: true, ...(await kg.ingestDocument(input)) });
      } catch (err) {
        return toolError('KG_INGEST_DOCUMENT_FAILED', `kg_ingest_document failed: ${String(err)}`, { sourceId: input.sourceId });
      }
    },
  );

  server.registerTool(
    'kg_get_document_chunks',
    {
      title: 'KG get document chunks',
      description: 'Returns a document and its chunks ordered by chunk metadata.order.',
      inputSchema: { sourceId: z.string().optional(), documentId: z.string().optional() },
      outputSchema: { ok: z.boolean(), document: nodeZ.nullable().optional(), chunks: z.array(nodeZ).optional(), error: errorObj },
      annotations: { title: 'KG get document chunks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, documentId }) => {
      try {
        if (!sourceId && !documentId) return toolError('KG_DOCUMENT_BAD_INPUT', 'Provide sourceId or documentId.');
        return toolStructured({ ok: true, ...(await kg.getDocumentChunks({ sourceId, documentId })) });
      } catch (err) {
        return toolError('KG_GET_DOCUMENT_CHUNKS_FAILED', `kg_get_document_chunks failed: ${String(err)}`, { sourceId, documentId });
      }
    },
  );

  server.registerTool(
    'kg_list_documents',
    {
      title: 'KG list documents',
      description: 'Lists imported document nodes. Optional sourceType filter.',
      inputSchema: { sourceType: z.string().optional(), limit: z.number().int().positive().optional() },
      outputSchema: { ok: z.boolean(), documents: z.array(nodeZ), error: errorObj },
      annotations: { title: 'KG list documents', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceType, limit }) => {
      try {
        return toolStructured({ ok: true, documents: await kg.listDocuments({ sourceType, limit }) });
      } catch (err) {
        return toolError('KG_LIST_DOCUMENTS_FAILED', `kg_list_documents failed: ${String(err)}`, { sourceType });
      }
    },
  );
}
