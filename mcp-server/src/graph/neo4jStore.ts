import crypto from 'node:crypto';
import neo4j, { Driver, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';
import { saveDocumentSource, type SavedDocumentSource } from '../services/backendClient.js';
import { assertCanonicalKind, isCanonicalKind, KG_KINDS_LIST } from './ontology.js';

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  content: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface GraphAsset {
  id: string;
  nodeId: string;
  path: string;
  mime: string;
  label: string;
  createdAt: string;
}

export interface NodeInput {
  type: string;
  label: string;
  content?: string;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface NodePatch {
  type?: string;
  label?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface EdgeInput {
  fromId: string;
  toId: string;
  kind: string;
  weight?: number;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface BulkSummary {
  received: number;
  created: number;
  merged: number;
  failed: number;
  dryRun: boolean;
}

export interface BulkNodeResult {
  type: string;
  label: string;
  status: 'created' | 'merged' | 'failed';
  nodeId?: string;
  reason?: string;
}

export interface BulkEdgeResult {
  fromId: string;
  toId: string;
  kind: string;
  status: 'created' | 'merged' | 'failed';
  edgeId?: string;
  reason?: string;
}

export interface DocumentChunkInput {
  order?: number;
  text: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestDocumentInput {
  sourceId: string;
  title?: string;
  sourceType?: string;
  content?: string;
  chunks?: DocumentChunkInput[];
  chunkSize?: number;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export interface IngestDocumentResult {
  document: GraphNode;
  chunks: GraphNode[];
  created: boolean;
  chunkCount: number;
  nas?: SavedDocumentSource;
}

let driver: Driver | null = null;
let ready: Promise<void> | null = null;

const nowIso = (): string => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();
const pid = (): string => config.projectId;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(neo4jUri(), neo4j.auth.basic(config.neo4jUser, config.neo4jPassword), {
      maxConnectionPoolSize: 20,
    });
  }
  return driver;
}

function neo4jUri(): string {
  return config.neo4jUri;
}

async function raw(cypher: string, params: Record<string, unknown>): Promise<Neo4jRecord[]> {
  const session = getDriver().session();
  try {
    const res = await session.run(cypher, params);
    return res.records;
  } finally {
    await session.close();
  }
}

async function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const statements = [
        'CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entity_project_type_label IF NOT EXISTS FOR (n:Entity) REQUIRE (n.projectId, n.type, n.label) IS UNIQUE',
        'CREATE CONSTRAINT asset_id IF NOT EXISTS FOR (a:Asset) REQUIRE a.id IS UNIQUE',
        'CREATE CONSTRAINT asset_project_node_path IF NOT EXISTS FOR (a:Asset) REQUIRE (a.projectId, a.nodeId, a.path) IS UNIQUE',
        "CREATE FULLTEXT INDEX entity_fts IF NOT EXISTS FOR (n:Entity) ON EACH [n.label, n.content] OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } }",
      ];
      for (const statement of statements) await raw(statement, {});
    })();
  }
  return ready;
}

async function run(cypher: string, params: Record<string, unknown>): Promise<Neo4jRecord[]> {
  await ensureReady();
  return raw(cypher, params);
}

export async function pingNeo4j(): Promise<boolean> {
  const records = await run('RETURN 1 AS ok', {});
  return records.length > 0;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
    ready = null;
  }
}

function safeJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toInt(value: unknown): number {
  return neo4j.isInt(value) ? (value as { toNumber(): number }).toNumber() : Number(value);
}

export function stableKey(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.keys(inner as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (inner as Record<string, unknown>)[key];
          return acc;
        }, {})
      : inner,
  );
}

export function mergeObj(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const previous = out[key];
    if (Array.isArray(value) && Array.isArray(previous)) {
      const seen = new Map<string, unknown>();
      for (const item of [...previous, ...value]) {
        const itemKey = stableKey(item);
        if (!seen.has(itemKey)) seen.set(itemKey, item);
      }
      out[key] = [...seen.values()];
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function nodeFrom(node: Node): GraphNode {
  const props = node.properties as Record<string, unknown>;
  return {
    id: String(props.id),
    type: String(props.type),
    label: String(props.label),
    content: String(props.content ?? ''),
    metadata: safeJson(props.metadata),
    provenance: safeJson(props.provenance),
    createdAt: String(props.createdAt ?? ''),
    updatedAt: String(props.updatedAt ?? ''),
  };
}

function edgeFrom(rel: Relationship, fromId: string, toId: string): GraphEdge {
  const props = rel.properties as Record<string, unknown>;
  return {
    id: String(props.id),
    fromId,
    toId,
    kind: String(props.kind),
    weight: Number(props.weight ?? 1),
    metadata: safeJson(props.metadata),
    provenance: safeJson(props.provenance),
    createdAt: String(props.createdAt ?? ''),
  };
}

function assetFrom(node: Node): GraphAsset {
  const props = node.properties as Record<string, unknown>;
  return {
    id: String(props.id),
    nodeId: String(props.nodeId),
    path: String(props.path),
    mime: String(props.mime ?? ''),
    label: String(props.label ?? ''),
    createdAt: String(props.createdAt ?? ''),
  };
}

function luceneQuery(query: string): string {
  const escape = (s: string): string => s.replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
  return query.split(/\s+/).map((token) => token.trim()).filter(Boolean).map(escape).join(' OR ');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = Math.trunc(Number(value));
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(numberValue, max));
}

export async function getNodeById(id: string): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {id:$id, projectId:$pid}) RETURN n', { id, pid: pid() });
  return records.length ? nodeFrom(records[0].get('n')) : null;
}

export async function getNodeByTypeLabel(type: string, label: string): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {projectId:$pid, type:$type, label:$label}) RETURN n LIMIT 1', {
    pid: pid(),
    type,
    label,
  });
  return records.length ? nodeFrom(records[0].get('n')) : null;
}

export async function addNode(input: NodeInput): Promise<GraphNode> {
  if (!input.type.trim() || !input.label.trim()) throw new Error('invalid_node: type and label are required');
  if (await getNodeByTypeLabel(input.type, input.label)) throw new Error(`node_exists: ${input.type}/${input.label}`);
  const id = uuid();
  const ts = nowIso();
  const records = await run(
    `CREATE (n:Entity {id:$id, projectId:$pid, type:$type, label:$label, content:$content,
      metadata:$metadata, provenance:$provenance, createdAt:$ts, updatedAt:$ts}) RETURN n`,
    {
      id,
      pid: pid(),
      type: input.type.trim(),
      label: input.label.trim(),
      content: input.content ?? '',
      metadata: JSON.stringify(input.metadata ?? {}),
      provenance: JSON.stringify(input.provenance ?? {}),
      ts,
    },
  );
  return nodeFrom(records[0].get('n'));
}

export async function upsertNode(input: NodeInput): Promise<{ node: GraphNode; created: boolean }> {
  const existing = await getNodeByTypeLabel(input.type.trim(), input.label.trim());
  if (!existing) return { node: await addNode(input), created: true };
  const node = await updateNode(existing.id, { content: input.content, metadata: input.metadata, provenance: input.provenance });
  return { node: node!, created: false };
}

export async function updateNode(id: string, patch: NodePatch): Promise<GraphNode | null> {
  const existing = await getNodeById(id);
  if (!existing) return null;
  const nextType = patch.type?.trim() || existing.type;
  const nextLabel = patch.label?.trim() || existing.label;
  if (nextType !== existing.type || nextLabel !== existing.label) {
    const conflict = await getNodeByTypeLabel(nextType, nextLabel);
    if (conflict && conflict.id !== id) throw new Error(`node_key_conflict: ${nextType}/${nextLabel}`);
  }
  const metadata = patch.metadata ? mergeObj(existing.metadata, patch.metadata) : existing.metadata;
  const provenance = patch.provenance ? mergeObj(existing.provenance, patch.provenance) : existing.provenance;
  const records = await run(
    `MATCH (n:Entity {id:$id, projectId:$pid})
     SET n.type=$type, n.label=$label, n.content=$content, n.metadata=$metadata, n.provenance=$provenance, n.updatedAt=$updatedAt
     RETURN n`,
    {
      id,
      pid: pid(),
      type: nextType,
      label: nextLabel,
      content: patch.content ?? existing.content,
      metadata: JSON.stringify(metadata),
      provenance: JSON.stringify(provenance),
      updatedAt: nowIso(),
    },
  );
  return records.length ? nodeFrom(records[0].get('n')) : null;
}

export async function deleteNode(id: string): Promise<boolean> {
  const records = await run(
    `MATCH (n:Entity {id:$id, projectId:$pid})
     OPTIONAL MATCH (n)-[:HAS_ASSET]->(asset:Asset {projectId:$pid})
     WITH n, collect(asset) AS assets
     FOREACH (asset IN assets | DETACH DELETE asset)
     WITH n, n.id AS nodeId
     DETACH DELETE n
     RETURN count(nodeId) AS c`,
    { id, pid: pid() },
  );
  return records.length ? toInt(records[0].get('c')) > 0 : false;
}

async function getEdgeByKey(fromId: string, toId: string, kind: string): Promise<GraphEdge | null> {
  const records = await run(
    `MATCH (a:Entity {id:$fromId, projectId:$pid})-[r:REL {kind:$kind}]->(b:Entity {id:$toId, projectId:$pid})
     RETURN r, a.id AS fromId, b.id AS toId LIMIT 1`,
    { fromId, toId, kind, pid: pid() },
  );
  return records.length ? edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId'))) : null;
}

export async function getEdgeById(edgeId: string): Promise<GraphEdge | null> {
  const records = await run(
    `MATCH (a:Entity {projectId:$pid})-[r:REL {id:$edgeId}]->(b:Entity {projectId:$pid})
     RETURN r, a.id AS fromId, b.id AS toId LIMIT 1`,
    { edgeId, pid: pid() },
  );
  return records.length ? edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId'))) : null;
}

export async function link(input: EdgeInput): Promise<GraphEdge> {
  assertCanonicalKind(input.kind);
  const from = await getNodeById(input.fromId);
  const to = await getNodeById(input.toId);
  if (!from || !to) throw new Error('node_not_found: fromId and toId must reference existing nodes');
  const existing = await getEdgeByKey(input.fromId, input.toId, input.kind);
  const ts = nowIso();
  if (existing) {
    const metadata = input.metadata ? mergeObj(existing.metadata, input.metadata) : existing.metadata;
    const provenance = input.provenance ? mergeObj(existing.provenance, input.provenance) : existing.provenance;
    const records = await run(
      `MATCH (a:Entity {id:$fromId, projectId:$pid})-[r:REL {kind:$kind}]->(b:Entity {id:$toId, projectId:$pid})
       SET r.weight=$weight, r.metadata=$metadata, r.provenance=$provenance
       RETURN r, a.id AS fromId, b.id AS toId`,
      {
        fromId: input.fromId,
        toId: input.toId,
        kind: input.kind,
        pid: pid(),
        weight: input.weight ?? existing.weight,
        metadata: JSON.stringify(metadata),
        provenance: JSON.stringify(provenance),
      },
    );
    return edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId')));
  }
  const records = await run(
    `MATCH (a:Entity {id:$fromId, projectId:$pid}), (b:Entity {id:$toId, projectId:$pid})
     CREATE (a)-[r:REL {id:$id, kind:$kind, weight:$weight, metadata:$metadata, provenance:$provenance, createdAt:$createdAt}]->(b)
     RETURN r, a.id AS fromId, b.id AS toId`,
    {
      fromId: input.fromId,
      toId: input.toId,
      kind: input.kind,
      pid: pid(),
      id: uuid(),
      weight: input.weight ?? 1,
      metadata: JSON.stringify(input.metadata ?? {}),
      provenance: JSON.stringify(input.provenance ?? {}),
      createdAt: ts,
    },
  );
  if (!records.length) throw new Error('node_not_found: fromId and toId must reference existing nodes');
  return edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId')));
}

export async function unlinkById(edgeId: string): Promise<boolean> {
  const records = await run(
    `MATCH (:Entity {projectId:$pid})-[r:REL {id:$edgeId}]->(:Entity {projectId:$pid})
     WITH r, r.id AS id DELETE r RETURN count(id) AS c`,
    { edgeId, pid: pid() },
  );
  return records.length ? toInt(records[0].get('c')) > 0 : false;
}

export async function unlink(fromId: string, toId: string, kind: string): Promise<boolean> {
  const records = await run(
    `MATCH (:Entity {id:$fromId, projectId:$pid})-[r:REL {kind:$kind}]->(:Entity {id:$toId, projectId:$pid})
     WITH r, r.id AS id DELETE r RETURN count(id) AS c`,
    { fromId, toId, kind, pid: pid() },
  );
  return records.length ? toInt(records[0].get('c')) > 0 : false;
}

export async function upsertNodes(
  nodes: NodeInput[],
  opts: { continueOnError?: boolean; dryRun?: boolean } = {},
): Promise<{ summary: BulkSummary; results: BulkNodeResult[] }> {
  const dryRun = opts.dryRun ?? false;
  const continueOnError = opts.continueOnError ?? true;
  const results: BulkNodeResult[] = [];
  let created = 0;
  let merged = 0;
  let failed = 0;
  for (const input of nodes) {
    if (!input.type?.trim() || !input.label?.trim()) {
      failed++;
      results.push({ type: input.type ?? '', label: input.label ?? '', status: 'failed', reason: 'invalid_payload' });
      if (!continueOnError) break;
      continue;
    }
    try {
      const existing = await getNodeByTypeLabel(input.type.trim(), input.label.trim());
      if (dryRun) {
        if (existing) merged++; else created++;
        results.push({ type: input.type, label: input.label, status: existing ? 'merged' : 'created', nodeId: existing?.id });
      } else {
        const written = await upsertNode(input);
        if (written.created) created++; else merged++;
        results.push({ type: input.type, label: input.label, status: written.created ? 'created' : 'merged', nodeId: written.node.id });
      }
    } catch (err) {
      failed++;
      results.push({ type: input.type, label: input.label, status: 'failed', reason: String(err) });
      if (!continueOnError) break;
    }
  }
  return { summary: { received: nodes.length, created, merged, failed, dryRun }, results };
}

export async function linkBulk(
  edges: EdgeInput[],
  opts: { continueOnError?: boolean; dryRun?: boolean } = {},
): Promise<{ summary: BulkSummary; results: BulkEdgeResult[] }> {
  const dryRun = opts.dryRun ?? false;
  const continueOnError = opts.continueOnError ?? true;
  const results: BulkEdgeResult[] = [];
  let created = 0;
  let merged = 0;
  let failed = 0;
  for (const input of edges) {
    try {
      assertCanonicalKind(input.kind);
      const from = await getNodeById(input.fromId);
      const to = await getNodeById(input.toId);
      if (!from || !to) throw new Error('node_not_found');
      const existing = await getEdgeByKey(input.fromId, input.toId, input.kind);
      if (dryRun) {
        if (existing) merged++; else created++;
        results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: existing ? 'merged' : 'created', edgeId: existing?.id });
      } else {
        const written = await link(input);
        if (existing) merged++; else created++;
        results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: existing ? 'merged' : 'created', edgeId: written.id });
      }
    } catch (err) {
      failed++;
      results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: 'failed', reason: String(err) });
      if (!continueOnError) break;
    }
  }
  return { summary: { received: edges.length, created, merged, failed, dryRun }, results };
}

export async function attachAsset(nodeId: string, asset: { path: string; mime?: string; label?: string }): Promise<GraphAsset> {
  if (!asset.path.trim()) throw new Error('invalid_asset: path is required');
  if (!(await getNodeById(nodeId))) throw new Error(`node_not_found: ${nodeId}`);
  const records = await run(
    `MATCH (n:Entity {id:$nodeId, projectId:$pid})
     MERGE (asset:Asset {projectId:$pid, nodeId:$nodeId, path:$path})
     ON CREATE SET asset.id=$id, asset.createdAt=$createdAt
     SET asset.mime=$mime, asset.label=$label
     MERGE (n)-[:HAS_ASSET]->(asset)
     RETURN asset`,
    {
      nodeId,
      pid: pid(),
      path: asset.path.trim(),
      id: uuid(),
      createdAt: nowIso(),
      mime: asset.mime ?? '',
      label: asset.label ?? '',
    },
  );
  return assetFrom(records[0].get('asset'));
}

export async function getAssets(nodeId: string): Promise<GraphAsset[]> {
  const records = await run(
    `MATCH (:Entity {id:$nodeId, projectId:$pid})-[:HAS_ASSET]->(asset:Asset {projectId:$pid, nodeId:$nodeId})
     RETURN asset ORDER BY asset.createdAt`,
    { nodeId, pid: pid() },
  );
  return records.map((record) => assetFrom(record.get('asset')));
}

function isMissingIndexError(err: unknown): boolean {
  return /entity_fts|fulltext|NoSuchIndex|no such (index|fulltext)/i.test(String(err));
}

export async function search(query: string, opts: { type?: string; limit?: number } = {}): Promise<GraphNode[]> {
  const q = luceneQuery(query);
  if (!q) return [];
  const limit = clampInt(opts.limit, 25, 1, 200);
  try {
    const records = await run(
      `CALL db.index.fulltext.queryNodes('entity_fts', $q) YIELD node, score
       WHERE node.projectId = $pid ${opts.type ? 'AND node.type = $type' : ''}
       RETURN node ORDER BY score DESC LIMIT $limit`,
      { q, pid: pid(), type: opts.type ?? null, limit: neo4j.int(limit) },
    );
    return records.map((record) => nodeFrom(record.get('node')));
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    const needle = query.trim();
    const records = await run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE (n.label CONTAINS $needle OR n.content CONTAINS $needle) ${opts.type ? 'AND n.type = $type' : ''}
       RETURN n LIMIT $limit`,
      { pid: pid(), needle, type: opts.type ?? null, limit: neo4j.int(limit) },
    );
    return records.map((record) => nodeFrom(record.get('n')));
  }
}

export async function listNodesByType(type: string, opts: { limit?: number } = {}): Promise<GraphNode[]> {
  const normalized = type.trim();
  if (!normalized) return [];
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run(
    'MATCH (n:Entity {projectId:$pid, type:$type}) RETURN n ORDER BY n.label LIMIT $limit',
    { pid: pid(), type: normalized, limit: neo4j.int(limit) },
  );
  return records.map((record) => nodeFrom(record.get('n')));
}

export async function listNodesByTypeLabelPrefix(type: string, labelPrefix: string, opts: { limit?: number } = {}): Promise<GraphNode[]> {
  const normalized = type.trim();
  const prefix = labelPrefix.trim();
  if (!normalized || !prefix) return [];
  const params: Record<string, unknown> = { pid: pid(), type: normalized, prefix };
  const limitClause = opts.limit ? ' LIMIT $limit' : '';
  if (opts.limit) params.limit = neo4j.int(Math.max(1, Math.trunc(opts.limit)));
  const records = await run(
    `MATCH (n:Entity {projectId:$pid, type:$type})
     WHERE n.label STARTS WITH $prefix
     RETURN n ORDER BY n.label${limitClause}`,
    params,
  );
  return records.map((record) => nodeFrom(record.get('n')));
}

export async function neighbors(nodeId: string, opts: { depth?: number; kinds?: string[] } = {}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const start = await getNodeById(nodeId);
  if (!start) return { nodes: [], edges: [] };
  const depth = clampInt(opts.depth, 1, 1, 5);
  const kinds = opts.kinds ?? [];
  const nodeMap = new Map<string, GraphNode>([[start.id, start]]);
  const edgeMap = new Map<string, GraphEdge>();
  let frontier = [start.id];
  for (let level = 0; level < depth && frontier.length; level++) {
    const records = await run(
      `MATCH (a:Entity {projectId:$pid})-[r:REL]-(b:Entity {projectId:$pid})
       WHERE (a.id IN $ids OR b.id IN $ids) AND (size($kinds) = 0 OR r.kind IN $kinds)
       RETURN a, b, r, startNode(r).id AS fromId, endNode(r).id AS toId`,
      { pid: pid(), ids: frontier, kinds },
    );
    const next: string[] = [];
    for (const record of records) {
      const a = nodeFrom(record.get('a'));
      const b = nodeFrom(record.get('b'));
      if (!nodeMap.has(a.id)) {
        nodeMap.set(a.id, a);
        next.push(a.id);
      }
      if (!nodeMap.has(b.id)) {
        nodeMap.set(b.id, b);
        next.push(b.id);
      }
      const edge = edgeFrom(record.get('r'), String(record.get('fromId')), String(record.get('toId')));
      edgeMap.set(edge.id, edge);
    }
    frontier = next;
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

export async function recall(query: string, opts: { depth?: number; limit?: number } = {}): Promise<{ matched: GraphNode[]; nodes: GraphNode[]; edges: GraphEdge[] }> {
  const matched = await search(query, { limit: opts.limit ?? 8 });
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  for (const node of matched) {
    nodeMap.set(node.id, node);
    const expanded = await neighbors(node.id, { depth: opts.depth ?? 1 });
    for (const expandedNode of expanded.nodes) nodeMap.set(expandedNode.id, expandedNode);
    for (const edge of expanded.edges) edgeMap.set(edge.id, edge);
  }
  return { matched, nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

export async function stats(): Promise<{ nodes: number; edges: number; nodeTypes: Record<string, number>; edgeKinds: Record<string, number> }> {
  const nodeCount = toInt((await run('MATCH (n:Entity {projectId:$pid}) RETURN count(n) AS c', { pid: pid() }))[0]?.get('c') ?? 0);
  const edgeCount = toInt((await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN count(r) AS c', { pid: pid() }))[0]?.get('c') ?? 0);
  const nodeTypes: Record<string, number> = {};
  for (const record of await run('MATCH (n:Entity {projectId:$pid}) RETURN n.type AS k, count(*) AS c ORDER BY c DESC', { pid: pid() })) {
    nodeTypes[String(record.get('k'))] = toInt(record.get('c'));
  }
  const edgeKinds: Record<string, number> = {};
  for (const record of await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN r.kind AS k, count(*) AS c ORDER BY c DESC', { pid: pid() })) {
    edgeKinds[String(record.get('k'))] = toInt(record.get('c'));
  }
  return { nodes: nodeCount, edges: edgeCount, nodeTypes, edgeKinds };
}

export interface GlobalAudit {
  nodes: number;
  edges: number;
  documents: number;
  chunks: number;
  assets: number;
  orphanNodes: number;
  orphanAssets: number;
  relatedToTotal: number;
  redundantRelatedTo: number;
  nonCanonicalKinds: Array<{ kind: string; count: number }>;
}

export async function auditGlobal(): Promise<GlobalAudit> {
  const one = async (cypher: string, params: Record<string, unknown> = {}): Promise<number> => {
    const records = await run(cypher, { pid: pid(), ...params });
    return records.length ? toInt(records[0].get('c')) : 0;
  };
  const nodes = await one('MATCH (n:Entity {projectId:$pid}) RETURN count(n) AS c');
  const edges = await one('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN count(r) AS c');
  const documents = await one("MATCH (n:Entity {projectId:$pid, type:'document'}) RETURN count(n) AS c");
  const chunks = await one("MATCH (n:Entity {projectId:$pid, type:'chunk'}) RETURN count(n) AS c");
  const assets = await one('MATCH (a:Asset {projectId:$pid}) RETURN count(a) AS c');
  const orphanNodes = await one('MATCH (n:Entity {projectId:$pid}) WHERE NOT (n)--() RETURN count(n) AS c');
  const orphanAssets = await one('MATCH (a:Asset {projectId:$pid}) WHERE NOT (:Entity {projectId:$pid})-[:HAS_ASSET]->(a) RETURN count(a) AS c');
  const relatedToTotal = await one("MATCH (:Entity {projectId:$pid})-[r:REL {kind:'related_to'}]->(:Entity {projectId:$pid}) RETURN count(r) AS c");
  const redundantRelatedTo = await one(
    `MATCH (a:Entity {projectId:$pid})-[r:REL {kind:'related_to'}]->(b:Entity {projectId:$pid})
     WHERE EXISTS { (a)-[typed:REL]-(b) WHERE typed.kind <> 'related_to' }
     RETURN count(r) AS c`,
  );
  const kindRows = await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN r.kind AS kind, count(r) AS c', { pid: pid() });
  const nonCanonicalKinds = kindRows
    .map((record) => ({ kind: String(record.get('kind')), count: toInt(record.get('c')) }))
    .filter((row) => !isCanonicalKind(row.kind))
    .sort((a, b) => b.count - a.count);
  return { nodes, edges, documents, chunks, assets, orphanNodes, orphanAssets, relatedToTotal, redundantRelatedTo, nonCanonicalKinds };
}

export interface RepairResult {
  dryRun: boolean;
  redundantRelatedToRetired: number;
  junkEdgesRemoved: number;
  orphanAssetsRemoved: number;
}

export async function repair(opts: { dryRun?: boolean } = {}): Promise<RepairResult> {
  const dryRun = opts.dryRun ?? true;
  const audit = await auditGlobal();
  const result: RepairResult = {
    dryRun,
    redundantRelatedToRetired: audit.redundantRelatedTo,
    junkEdgesRemoved: audit.nonCanonicalKinds.reduce((sum, row) => sum + row.count, 0),
    orphanAssetsRemoved: audit.orphanAssets,
  };
  if (!dryRun) {
    await run(
      `MATCH (a:Entity {projectId:$pid})-[r:REL {kind:'related_to'}]->(b:Entity {projectId:$pid})
       WHERE EXISTS { (a)-[typed:REL]-(b) WHERE typed.kind <> 'related_to' }
       DELETE r`,
      { pid: pid() },
    );
    await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) WHERE NOT r.kind IN $allowed DELETE r', { pid: pid(), allowed: KG_KINDS_LIST });
    await run('MATCH (a:Asset {projectId:$pid}) WHERE NOT (:Entity {projectId:$pid})-[:HAS_ASSET]->(a) DETACH DELETE a', { pid: pid() });
  }
  return result;
}

export function chunkText(text: string, chunkSize = 4000): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const size = clampInt(chunkSize, 4000, 500, 20000);
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf('\n\n', end);
      const lineBreak = normalized.lastIndexOf('\n', end);
      const softBreak = paragraphBreak > start + size * 0.55 ? paragraphBreak : lineBreak > start + size * 0.55 ? lineBreak : -1;
      if (softBreak > start) end = softBreak;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
    while (start < normalized.length && /\s/.test(normalized[start])) start++;
  }
  return chunks;
}

function normalizeDocumentChunks(input: IngestDocumentInput): Array<{ order: number; text: string; label?: string; metadata?: Record<string, unknown> }> {
  if (input.chunks?.length) {
    return input.chunks
      .map((chunk, index) => ({ order: chunk.order ?? index + 1, text: chunk.text.trim(), label: chunk.label, metadata: chunk.metadata }))
      .filter((chunk) => chunk.text.length > 0)
      .sort((a, b) => a.order - b.order);
  }
  return chunkText(input.content ?? '', input.chunkSize).map((text, index) => ({ order: index + 1, text }));
}

export async function ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult> {
  const sourceId = input.sourceId.trim();
  if (!sourceId) throw new Error('invalid_document: sourceId is required');
  const title = input.title?.trim() || sourceId;
  const chunks = normalizeDocumentChunks(input);
  const nas = await saveDocumentSource({
    sourceId,
    content: input.content,
    metadata: { ...(input.metadata ?? {}), title, sourceType: input.sourceType ?? 'generic' },
  }).catch((err): SavedDocumentSource => ({ saved: false, error: String(err) }));
  const metadata = {
    ...(input.metadata ?? {}),
    sourceId,
    sourceType: input.sourceType ?? 'generic',
    title,
    chunkCount: chunks.length,
    ingestedAt: nowIso(),
    nas,
  };
  const documentWrite = await upsertNode({
    type: 'document',
    label: sourceId,
    content: title,
    metadata,
    provenance: input.provenance ?? {},
  });
  const chunkNodes: GraphNode[] = [];
  for (const chunk of chunks) {
    const chunkLabel = chunk.label?.trim() || `${sourceId}#${String(chunk.order).padStart(5, '0')}`;
    const written = await upsertNode({
      type: 'chunk',
      label: chunkLabel,
      content: chunk.text,
      metadata: {
        ...(chunk.metadata ?? {}),
        sourceId,
        sourceType: input.sourceType ?? 'generic',
        documentId: documentWrite.node.id,
        documentLabel: documentWrite.node.label,
        title,
        order: chunk.order,
      },
      provenance: input.provenance ?? {},
    });
    await link({ fromId: written.node.id, toId: documentWrite.node.id, kind: 'part_of', provenance: { source: 'kg_ingest_document', sourceId } });
    chunkNodes.push(written.node);
  }
  for (let index = 0; index < chunkNodes.length - 1; index++) {
    await link({ fromId: chunkNodes[index].id, toId: chunkNodes[index + 1].id, kind: 'precedes', provenance: { source: 'kg_ingest_document', sourceId } });
  }
  if (nas.saved && nas.path) {
    await attachAsset(documentWrite.node.id, { path: nas.path, mime: 'text/plain', label: 'source' });
  }
  return { document: documentWrite.node, chunks: chunkNodes, created: documentWrite.created, chunkCount: chunkNodes.length, nas };
}

export async function getDocumentChunks(opts: { sourceId?: string; documentId?: string }): Promise<{ document: GraphNode | null; chunks: GraphNode[] }> {
  const document = opts.documentId ? await getNodeById(opts.documentId) : opts.sourceId ? await getNodeByTypeLabel('document', opts.sourceId) : null;
  if (!document) return { document: null, chunks: [] };
  const records = await run(
    `MATCH (chunk:Entity {projectId:$pid, type:'chunk'})-[:REL {kind:'part_of'}]->(:Entity {projectId:$pid, id:$documentId})
     RETURN chunk`,
    { pid: pid(), documentId: document.id },
  );
  const chunks = records
    .map((record) => nodeFrom(record.get('chunk')))
    .sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0));
  return { document, chunks };
}

export async function listDocuments(opts: { sourceType?: string; limit?: number } = {}): Promise<GraphNode[]> {
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run("MATCH (n:Entity {projectId:$pid, type:'document'}) RETURN n ORDER BY n.updatedAt DESC LIMIT $limit", { pid: pid(), limit: neo4j.int(limit) });
  const docs = records.map((record) => nodeFrom(record.get('n')));
  return opts.sourceType ? docs.filter((doc) => doc.metadata.sourceType === opts.sourceType) : docs;
}
