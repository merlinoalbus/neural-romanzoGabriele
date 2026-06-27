import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { KG_KINDS_LIST } from '../graph/ontology.js';
import { embedText, embeddingRuntimeStatus, embeddingText, getEmbeddingSettings } from '../services/embeddingService.js';
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

const bulkDeleteNodeSummaryZ = z.object({
  received: z.number(),
  unique: z.number(),
  deleted: z.number(),
  notFound: z.number(),
  dryRun: z.boolean(),
});

const bulkDeleteNodeResultZ = z.object({
  id: z.string(),
  status: z.enum(['planned', 'deleted', 'not_found']),
});

const statsShape = {
  ok: z.boolean(),
  nodes: z.number(),
  edges: z.number(),
  nodeTypes: z.record(z.string(), z.number()),
  edgeKinds: z.record(z.string(), z.number()),
};

const embeddingRuntimeStatusZ = z.object({
  configured: z.boolean(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  dimensions: z.number().nullable(),
  missing: z.array(z.string()),
});

const graphEmbeddingStatusZ = z.object({
  vectorIndexName: z.string(),
  vectorIndexExists: z.boolean(),
  nodes: z.number(),
  embeddedNodes: z.number(),
  pendingNodes: z.number(),
  lastEmbeddedAt: z.string().nullable(),
});

const embeddingCandidateZ = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  textHash: z.string(),
  status: z.enum(['planned', 'embedded', 'failed']),
  reason: z.string().optional(),
});

const semanticResultZ = z.object({
  node: nodeZ,
  score: z.number(),
});

const nonRelPhysicalEdgePlanZ = z.object({
  total: z.number(),
  converted: z.number(),
  removed: z.number(),
  unresolved: z.number(),
  convertedByKind: z.record(z.string(), z.number()),
  removedByReason: z.record(z.string(), z.number()),
  unresolvedBySignature: z.record(z.string(), z.number()),
  samples: z.array(z.object({
    action: z.enum(['convert', 'remove', 'unresolved']),
    kind: z.string().optional(),
    reason: z.string(),
    physicalType: z.string(),
    rawKind: z.string(),
    fromId: z.string(),
    toId: z.string(),
    fromType: z.string(),
    toType: z.string(),
    fromLabel: z.string().optional(),
    toLabel: z.string().optional(),
  })),
});

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
      description: 'Creates or merges many nodes.',
      inputSchema: {
        nodes: z.array(nodeInputZ).min(1).max(1000),
        continueOnError: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), summary: bulkSummaryZ.optional(), results: z.array(bulkNodeResultZ).optional(), error: errorObj },
      annotations: { title: 'KG upsert nodes bulk', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ nodes, continueOnError }) => {
      try {
        const { summary, results } = await kg.upsertNodes(nodes, { continueOnError });
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
    'kg_delete_nodes',
    {
      title: 'KG delete nodes',
      description: 'Deletes many graph nodes by id and detaches connected relationships. Use dryRun=true to preview.',
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).max(1000),
        dryRun: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: bulkDeleteNodeSummaryZ.optional(),
        results: z.array(bulkDeleteNodeResultZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'KG delete nodes', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, dryRun }) => {
      try {
        const result = await kg.deleteNodes(ids, { dryRun });
        return toolStructured({ ok: true, ...result });
      } catch (err) {
        return toolError('KG_DELETE_NODES_FAILED', `kg_delete_nodes failed: ${String(err)}`, { count: ids.length, dryRun });
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
      description: 'Creates or merges many directed edges.',
      inputSchema: {
        edges: z.array(edgeInputZ).min(1).max(1000),
        continueOnError: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), summary: bulkSummaryZ.optional(), results: z.array(bulkEdgeResultZ).optional(), error: errorObj },
      annotations: { title: 'KG link bulk', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ edges, continueOnError }) => {
      try {
        const { summary, results } = await kg.linkBulk(edges, { continueOnError });
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
      description: 'Disabled: filesystem asset registration is not allowed in this project.',
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
    'kg_embedding_status',
    {
      title: 'KG embedding status',
      description: 'Reports embeddings provider configuration, vector index status, and graph embedding coverage. Read-only.',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), runtime: embeddingRuntimeStatusZ, graph: graphEmbeddingStatusZ.optional(), error: errorObj },
      annotations: { title: 'KG embedding status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toolStructured({ ok: true, runtime: embeddingRuntimeStatus(), graph: await kg.embeddingStatus() });
      } catch (err) {
        return toolError('KG_EMBEDDING_STATUS_FAILED', `kg_embedding_status failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'kg_backfill_embeddings',
    {
      title: 'KG backfill embeddings',
      description: 'Generates real vector embeddings for graph nodes and ensures the Neo4j vector index.',
      inputSchema: {
        limit: z.number().int().positive().optional(),
        type: z.string().optional(),
        missingOnly: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        runtime: embeddingRuntimeStatusZ.optional(),
        graph: graphEmbeddingStatusZ.optional(),
        candidates: z.array(embeddingCandidateZ).optional(),
        summary: z.object({
          selected: z.number(),
          embedded: z.number(),
          failed: z.number(),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'KG backfill embeddings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, type, missingOnly }) => {
      const settings = getEmbeddingSettings();
      const runtime = embeddingRuntimeStatus(settings);
      if (!runtime.configured) {
        return toolError('KG_EMBEDDINGS_NOT_CONFIGURED', 'Embeddings provider is not configured; no fake vectors were generated.', { missing: runtime.missing });
      }
      try {
        const candidates = await kg.listEmbeddingCandidates({ limit, type, missingOnly });
        const results: Array<z.infer<typeof embeddingCandidateZ>> = [];
        let embedded = 0;
        let failed = 0;
        let indexReady = false;
        for (const node of candidates) {
          const text = embeddingText(node);
          const textHash = kg.embeddingTextHash(text);
          try {
            const vector = await embedText(text, settings);
            if (!indexReady) {
              await kg.createEmbeddingIndex(vector.length);
              indexReady = true;
            }
            const written = await kg.writeNodeEmbedding(node.id, vector, {
              provider: settings.provider,
              model: settings.model,
              dimensions: vector.length,
              textHash,
            });
            if (!written) throw new Error('node_not_found');
            embedded++;
            results.push({ id: node.id, type: node.type, label: node.label, textHash, status: 'embedded' });
          } catch (err) {
            failed++;
            results.push({ id: node.id, type: node.type, label: node.label, textHash, status: 'failed', reason: String(err) });
          }
        }
        return toolStructured({
          ok: failed === 0,
          runtime,
          graph: await kg.embeddingStatus(),
          candidates: results,
          summary: { selected: candidates.length, embedded, failed },
        });
      } catch (err) {
        return toolError('KG_BACKFILL_EMBEDDINGS_FAILED', `kg_backfill_embeddings failed: ${String(err)}`, { type, limit, missingOnly });
      }
    },
  );

  server.registerTool(
    'kg_semantic_search',
    {
      title: 'KG semantic search',
      description: 'Searches graph nodes by deep semantic vector affinity. Requires configured real embeddings and a populated vector index.',
      inputSchema: { query: z.string(), type: z.string().optional(), limit: z.number().int().positive().optional() },
      outputSchema: { ok: z.boolean(), runtime: embeddingRuntimeStatusZ.optional(), results: z.array(semanticResultZ).optional(), error: errorObj },
      annotations: { title: 'KG semantic search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, type, limit }) => {
      const settings = getEmbeddingSettings();
      const runtime = embeddingRuntimeStatus(settings);
      if (!runtime.configured) {
        return toolError('KG_EMBEDDINGS_NOT_CONFIGURED', 'Embeddings provider is not configured; semantic search cannot run without real vectors.', { missing: runtime.missing });
      }
      try {
        const graph = await kg.embeddingStatus();
        if (!graph.vectorIndexExists || graph.embeddedNodes === 0) {
          return toolError('KG_EMBEDDINGS_NOT_READY', 'Semantic search requires a populated Neo4j vector index. Run kg_backfill_embeddings first.', {
            vectorIndexName: graph.vectorIndexName,
            vectorIndexExists: graph.vectorIndexExists,
            embeddedNodes: graph.embeddedNodes,
            pendingNodes: graph.pendingNodes,
          });
        }
        const vector = await embedText(query, settings);
        return toolStructured({ ok: true, runtime, results: await kg.semanticSearch(vector, { type, limit }) });
      } catch (err) {
        return toolError('KG_SEMANTIC_SEARCH_FAILED', `kg_semantic_search failed: ${String(err)}`, { type, limit });
      }
    },
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
          physicalEdges: z.number(),
          nonRelPhysicalEdges: z.number(),
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
      description: 'Deterministic graph cleanup. Applies repairs directly.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        redundantRelatedToRetired: z.number().optional(),
        junkEdgesRemoved: z.number().optional(),
        orphanAssetsRemoved: z.number().optional(),
        nonRelPhysicalEdgesConverted: z.number().optional(),
        nonRelPhysicalEdgesRemoved: z.number().optional(),
        unresolvedNonRelPhysicalEdges: z.number().optional(),
        nonRelPhysicalEdgePlan: nonRelPhysicalEdgePlanZ.optional(),
        nonRelPhysicalEdgeApply: z.object({
          createdNew: z.number(),
          mergedExisting: z.number(),
          deletedOriginal: z.number(),
          removedSelfLoop: z.number(),
          removedLegacy: z.number(),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'KG repair', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toolStructured({ ok: true, ...(await kg.repair()) });
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
