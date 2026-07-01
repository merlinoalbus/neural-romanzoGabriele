import crypto from 'node:crypto';
import neo4j, { Driver, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';
import { saveDocumentSource, type SavedDocumentSource } from '../services/backendClient.js';
import { embeddingText } from '../services/embeddingService.js';
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

export interface BulkDeleteNodeResult {
  id: string;
  status: 'planned' | 'deleted' | 'not_found';
}

export interface BulkDeleteNodeSummary {
  received: number;
  unique: number;
  deleted: number;
  notFound: number;
  dryRun: boolean;
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

export interface EmbeddingCandidate extends GraphNode {
  embeddingTextHash: string;
  embeddingModel: string;
  embeddingProvider: string;
  embeddingDimensions: number | null;
}

export interface SemanticSearchResult {
  node: GraphNode;
  score: number;
}

export interface GraphEmbeddingStatus {
  vectorIndexName: string;
  vectorIndexExists: boolean;
  nodes: number;
  embeddedNodes: number;
  pendingNodes: number;
  lastEmbeddedAt: string | null;
}

export interface NonRelPhysicalEdgeCandidate {
  relElementId?: string;
  physicalType: string;
  rawKind: string;
  fromId: string;
  toId: string;
  fromType: string;
  toType: string;
  fromLabel?: string;
  toLabel?: string;
  metadata: string;
  provenance: string;
  edgeId?: string;
  weight?: number;
  createdAt?: string;
}

export type NonRelPhysicalEdgeClassification =
  | { action: 'convert'; kind: string; reason: string }
  | { action: 'remove'; reason: 'self_loop_redundant' | 'legacy_overgenerated_ally_of' }
  | { action: 'unresolved'; reason: string };

export interface NonRelPhysicalEdgeRepairPlan {
  total: number;
  converted: number;
  removed: number;
  unresolved: number;
  convertedByKind: Record<string, number>;
  removedByReason: Record<string, number>;
  unresolvedBySignature: Record<string, number>;
  samples: Array<{
    action: NonRelPhysicalEdgeClassification['action'];
    kind?: string;
    reason: string;
    physicalType: string;
    rawKind: string;
    fromId: string;
    toId: string;
    fromType: string;
    toType: string;
    fromLabel?: string;
    toLabel?: string;
  }>;
}

let driver: Driver | null = null;
let ready: Promise<void> | null = null;

const nowIso = (): string => new Date().toISOString();
const uuid = (): string => crypto.randomUUID();
const pid = (): string => config.projectId;
export const ENTITY_EMBEDDING_INDEX = 'entity_embedding';

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

export async function runQuery(cypher: string, params: Record<string, unknown>): Promise<Neo4jRecord[]> {
  return run(cypher, params);
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

export function embeddingTextHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function addCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

const SECTION_EVIDENCE_FROM_TYPES = new Set([
  'artifact',
  'bible_candidate',
  'bible_coverage_finding',
  'character',
  'character_voice',
  'motif',
  'narrative_constraint',
  'plot_thread',
  'power',
  'relationship_dynamic',
  'secret',
  'theme',
  'world_rule',
]);

const COVERAGE_TARGET_TYPES = new Set(['artifact', 'plot_thread', 'relationship_dynamic', 'secret', 'theme', 'world_rule']);

export function classifyNonRelPhysicalEdge(edge: NonRelPhysicalEdgeCandidate): NonRelPhysicalEdgeClassification {
  const physicalType = edge.physicalType.trim();
  const rawKind = edge.rawKind.trim();
  const metadata = edge.metadata ?? '';
  const provenance = edge.provenance ?? '';
  const fromType = edge.fromType.trim();
  const toType = edge.toType.trim();

  if (edge.fromId.trim() === edge.toId.trim()) return { action: 'remove', reason: 'self_loop_redundant' };
  if (
    physicalType === 'Relationship' &&
    rawKind === 'ally_of' &&
    provenance.includes('consolidation_engine') &&
    metadata.includes('inferred') &&
    metadata.includes('char_faction_intermediate') &&
    !metadata.includes('evidence') &&
    !metadata.includes('sourceId')
  ) {
    return { action: 'remove', reason: 'legacy_overgenerated_ally_of' };
  }
  if (rawKind !== 'REL' && rawKind !== 'Relationship' && isCanonicalKind(rawKind)) {
    return { action: 'convert', kind: rawKind, reason: 'canonical_raw_kind' };
  }
  if (isCanonicalKind(physicalType)) {
    return { action: 'convert', kind: physicalType, reason: 'canonical_physical_type' };
  }
  if (metadata.includes('parentSectionKey')) return { action: 'convert', kind: 'part_of', reason: 'section_parent_metadata' };
  if (metadata.includes('orderScope')) return { action: 'convert', kind: 'precedes', reason: 'section_order_metadata' };
  if (fromType === 'bible_section' && toType === 'bible_outline') return { action: 'convert', kind: 'part_of', reason: 'section_outline_parent' };
  if (fromType === 'bible_candidate' && toType === 'bible_section') return { action: 'convert', kind: 'derived_from', reason: 'candidate_section_evidence' };
  if (fromType === 'bible_coverage_finding' && toType === 'bible_section') return { action: 'convert', kind: 'derived_from', reason: 'coverage_section_evidence' };
  if (fromType === 'bible_coverage_finding' && COVERAGE_TARGET_TYPES.has(toType)) return { action: 'convert', kind: 'applies_to', reason: 'coverage_target' };
  if (toType === 'bible_section' && SECTION_EVIDENCE_FROM_TYPES.has(fromType)) return { action: 'convert', kind: 'derived_from', reason: 'source_section_evidence' };
  if (fromType === 'character' && toType === 'relationship_dynamic') return { action: 'convert', kind: 'about', reason: 'character_relationship_dynamic' };
  if (fromType === 'relationship_dynamic' && toType === 'character') return { action: 'convert', kind: 'about', reason: 'relationship_dynamic_character' };
  if (fromType === 'character' && toType === 'artifact' && metadata.includes('creates')) return { action: 'convert', kind: 'creates', reason: 'candidate_creates_artifact' };
  if (fromType === 'symbol' && toType === 'artifact') return { action: 'convert', kind: 'symbolizes', reason: 'symbol_artifact' };
  if (fromType === 'secret' && toType === 'timeline_event') return { action: 'convert', kind: 'revealed_in', reason: 'secret_event_revelation' };
  if (fromType === 'world_rule' && toType === 'world_rule' && metadata.toLowerCase().includes('exception')) {
    return { action: 'convert', kind: 'is_exception_to', reason: 'world_rule_exception' };
  }
  return { action: 'unresolved', reason: 'no_specific_mapping' };
}

export function summarizeNonRelPhysicalEdgeRepair(edges: NonRelPhysicalEdgeCandidate[], sampleLimit = 25): NonRelPhysicalEdgeRepairPlan {
  const plan: NonRelPhysicalEdgeRepairPlan = {
    total: edges.length,
    converted: 0,
    removed: 0,
    unresolved: 0,
    convertedByKind: {},
    removedByReason: {},
    unresolvedBySignature: {},
    samples: [],
  };
  for (const edge of edges) {
    const classification = classifyNonRelPhysicalEdge(edge);
    if (classification.action === 'convert') {
      plan.converted++;
      addCount(plan.convertedByKind, classification.kind);
    } else if (classification.action === 'remove') {
      plan.removed++;
      addCount(plan.removedByReason, classification.reason);
    } else {
      plan.unresolved++;
      addCount(plan.unresolvedBySignature, `${edge.physicalType}/${edge.rawKind}/${edge.fromType}->${edge.toType}`);
    }
    if (plan.samples.length < sampleLimit) {
      plan.samples.push({
        action: classification.action,
        kind: classification.action === 'convert' ? classification.kind : undefined,
        reason: classification.reason,
        physicalType: edge.physicalType,
        rawKind: edge.rawKind,
        fromId: edge.fromId,
        toId: edge.toId,
        fromType: edge.fromType,
        toType: edge.toType,
        fromLabel: edge.fromLabel,
        toLabel: edge.toLabel,
      });
    }
  }
  return plan;
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

export async function deleteNodes(
  ids: string[],
  opts: { dryRun?: boolean } = {},
): Promise<{ summary: BulkDeleteNodeSummary; results: BulkDeleteNodeResult[] }> {
  const dryRun = opts.dryRun ?? false;
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) {
    return {
      summary: { received: ids.length, unique: 0, deleted: 0, notFound: 0, dryRun },
      results: [],
    };
  }

  const existingRows = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE n.id IN $ids
     RETURN n.id AS id`,
    { pid: pid(), ids: uniqueIds },
  );
  const existingIds = new Set(existingRows.map((record) => String(record.get('id'))));

  if (!dryRun && existingIds.size) {
    await run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE n.id IN $ids
       OPTIONAL MATCH (n)-[:HAS_ASSET]->(asset:Asset {projectId:$pid})
       WITH n, collect(asset) AS assets
       FOREACH (asset IN assets | DETACH DELETE asset)
       WITH collect(n) AS nodes
       FOREACH (node IN nodes | DETACH DELETE node)`,
      { pid: pid(), ids: [...existingIds] },
    );
  }

  const results = uniqueIds.map((id) => ({
    id,
    status: existingIds.has(id) ? (dryRun ? 'planned' : 'deleted') : 'not_found',
  }) satisfies BulkDeleteNodeResult);
  const notFound = results.filter((result) => result.status === 'not_found').length;
  return {
    summary: {
      received: ids.length,
      unique: uniqueIds.length,
      deleted: dryRun ? 0 : existingIds.size,
      notFound,
      dryRun,
    },
    results,
  };
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
  opts: { continueOnError?: boolean } = {},
): Promise<{ summary: BulkSummary; results: BulkNodeResult[] }> {
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
      const written = await upsertNode(input);
      if (written.created) created++; else merged++;
      results.push({ type: input.type, label: input.label, status: existing ? 'merged' : 'created', nodeId: written.node.id });
    } catch (err) {
      failed++;
      results.push({ type: input.type, label: input.label, status: 'failed', reason: String(err) });
      if (!continueOnError) break;
    }
  }
  return { summary: { received: nodes.length, created, merged, failed }, results };
}

export async function linkBulk(
  edges: EdgeInput[],
  opts: { continueOnError?: boolean } = {},
): Promise<{ summary: BulkSummary; results: BulkEdgeResult[] }> {
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
      const written = await link(input);
      if (existing) merged++; else created++;
      results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: existing ? 'merged' : 'created', edgeId: written.id });
    } catch (err) {
      failed++;
      results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: 'failed', reason: String(err) });
      if (!continueOnError) break;
    }
  }
  return { summary: { received: edges.length, created, merged, failed }, results };
}

export async function attachAsset(nodeId: string, asset: { path: string; mime?: string; label?: string }): Promise<GraphAsset> {
  void nodeId;
  void asset;
  throw new Error('filesystem_asset_registration_disabled');
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

export async function listNodesByTypeBibleSection(
  type: string,
  input: { sourceId: string; sectionKey: string; limit?: number },
): Promise<GraphNode[]> {
  const normalized = type.trim();
  const sourceId = input.sourceId.trim();
  const sectionKey = input.sectionKey.trim();
  if (!normalized || !sourceId || !sectionKey) return [];
  const limit = clampInt(input.limit, 100, 1, 500);
  const sectionNeedle = `"sectionKey":"${sectionKey}"`;
  const sourceNeedle = `"sourceId":"${sourceId}"`;
  const records = await run(
    `MATCH (n:Entity {projectId:$pid, type:$type})
     WHERE n.label = $exactLabel
       OR n.label STARTS WITH $labelCandidatePrefix
       OR ((n.metadata CONTAINS $sectionNeedle OR n.provenance CONTAINS $sectionNeedle)
         AND (n.metadata CONTAINS $sourceNeedle OR n.provenance CONTAINS $sourceNeedle))
     RETURN n ORDER BY coalesce(n.updatedAt, n.createdAt, ''), n.label LIMIT $limit`,
    {
      pid: pid(),
      type: normalized,
      exactLabel: `${sourceId}::${sectionKey}`,
      labelCandidatePrefix: `${sourceId}::${sectionKey}::`,
      sectionNeedle,
      sourceNeedle,
      limit: neo4j.int(limit),
    },
  );
  return records.map((record) => nodeFrom(record.get('n')));
}

export async function listBibleCandidatesBySection(input: { sourceId: string; sectionKey: string; limit?: number }): Promise<GraphNode[]> {
  return listNodesByTypeBibleSection('bible_candidate', input);
}

export async function getBibleCandidateByIdOrLabel(sourceId: string, candidateId: string): Promise<GraphNode | null> {
  const normalizedSourceId = sourceId.trim();
  const normalizedCandidateId = candidateId.trim();
  if (!normalizedSourceId || !normalizedCandidateId) return null;
  const records = await run(
    `MATCH (n:Entity {projectId:$pid, type:'bible_candidate'})
     WHERE (n.id = $candidateId OR n.label = $candidateId)
       AND (n.metadata CONTAINS $sourceNeedle OR n.provenance CONTAINS $sourceNeedle)
     RETURN n LIMIT 1`,
    { pid: pid(), candidateId: normalizedCandidateId, sourceNeedle: `"sourceId":"${normalizedSourceId}"` },
  );
  return records.length ? nodeFrom(records[0].get('n')) : null;
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

export async function edgesForNodeIds(nodeIds: string[]): Promise<GraphEdge[]> {
  if (!nodeIds.length) return [];
  const records = await run(
    `MATCH (a:Entity {projectId:$pid})-[r:REL]-(b:Entity {projectId:$pid})
     WHERE a.id IN $ids OR b.id IN $ids
     RETURN r, startNode(r).id AS fromId, endNode(r).id AS toId`,
    { pid: pid(), ids: nodeIds },
  );
  const edgeMap = new Map<string, GraphEdge>();
  for (const record of records) {
    const edge = edgeFrom(record.get('r'), String(record.get('fromId')), String(record.get('toId')));
    edgeMap.set(edge.id, edge);
  }
  return [...edgeMap.values()];
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

async function embeddingIndexExists(): Promise<boolean> {
  try {
    const records = await run(`SHOW INDEXES YIELD name WHERE name = '${ENTITY_EMBEDDING_INDEX}' RETURN count(*) AS c`, {});
    return records.length ? toInt(records[0].get('c')) > 0 : false;
  } catch {
    return false;
  }
}

export async function createEmbeddingIndex(dimensions: number): Promise<void> {
  const dim = Math.trunc(dimensions);
  if (!Number.isFinite(dim) || dim <= 0 || dim > 8192) throw new Error('invalid_embedding_dimensions: dimensions must be between 1 and 8192');
  await run(
    `CREATE VECTOR INDEX ${ENTITY_EMBEDDING_INDEX} IF NOT EXISTS FOR (n:Entity) ON (n.embedding)
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${dim}, \`vector.similarity_function\`: 'cosine' } }`,
    {},
  );
}

export async function embeddingStatus(): Promise<GraphEmbeddingStatus> {
  const records = await run(
    `MATCH (n:Entity {projectId:$pid})
     RETURN count(n) AS nodes,
       count(n.embedding) AS embeddedNodes,
       sum(CASE WHEN n.embedding IS NULL THEN 1 ELSE 0 END) AS pendingNodes,
       max(n.embeddingUpdatedAt) AS lastEmbeddedAt`,
    { pid: pid() },
  );
  const record = records[0];
  return {
    vectorIndexName: ENTITY_EMBEDDING_INDEX,
    vectorIndexExists: await embeddingIndexExists(),
    nodes: record ? toInt(record.get('nodes')) : 0,
    embeddedNodes: record ? toInt(record.get('embeddedNodes')) : 0,
    pendingNodes: record ? toInt(record.get('pendingNodes')) : 0,
    lastEmbeddedAt: record?.get('lastEmbeddedAt') ? String(record.get('lastEmbeddedAt')) : null,
  };
}

function embeddingCandidateFrom(node: Node): EmbeddingCandidate {
  const graphNode = nodeFrom(node);
  const props = node.properties as Record<string, unknown>;
  const text = embeddingText(graphNode);
  return {
    ...graphNode,
    embeddingTextHash: String(props.embeddingTextHash ?? embeddingTextHash(text)),
    embeddingModel: String(props.embeddingModel ?? ''),
    embeddingProvider: String(props.embeddingProvider ?? ''),
    embeddingDimensions: props.embeddingDimensions == null ? null : Number(props.embeddingDimensions),
  };
}

export async function listEmbeddingCandidates(opts: { type?: string; limit?: number; missingOnly?: boolean } = {}): Promise<EmbeddingCandidate[]> {
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const type = opts.type?.trim() || null;
  const missingOnly = opts.missingOnly ?? true;
  const records = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE ($type IS NULL OR n.type = $type)
       AND ($missingOnly = false OR n.embedding IS NULL)
     RETURN n
     ORDER BY coalesce(n.updatedAt, n.createdAt, '') DESC, n.label
     LIMIT $limit`,
    { pid: pid(), type, missingOnly, limit: neo4j.int(limit) },
  );
  return records.map((record) => embeddingCandidateFrom(record.get('n')));
}

export async function writeNodeEmbedding(
  nodeId: string,
  vector: number[],
  metadata: { provider: string; model: string; dimensions: number; textHash: string },
): Promise<boolean> {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error('invalid_embedding: vector must contain finite numbers');
  const records = await run(
    `MATCH (n:Entity {id:$id, projectId:$pid})
     SET n.embedding=$embedding,
       n.embeddingProvider=$provider,
       n.embeddingModel=$model,
       n.embeddingDimensions=$dimensions,
       n.embeddingTextHash=$textHash,
       n.embeddingUpdatedAt=$updatedAt
     RETURN count(n) AS c`,
    {
      id: nodeId,
      pid: pid(),
      embedding: vector,
      provider: metadata.provider,
      model: metadata.model,
      dimensions: neo4j.int(metadata.dimensions),
      textHash: metadata.textHash,
      updatedAt: nowIso(),
    },
  );
  return records.length ? toInt(records[0].get('c')) > 0 : false;
}

export async function semanticSearch(vector: number[], opts: { type?: string; limit?: number } = {}): Promise<SemanticSearchResult[]> {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error('invalid_embedding: vector must contain finite numbers');
  const limit = clampInt(opts.limit, 10, 1, 100);
  const requestLimit = Math.min(Math.max(limit * 4, limit), 400);
  const type = opts.type?.trim() || null;
  const records = await run(
    `CALL db.index.vector.queryNodes('${ENTITY_EMBEDDING_INDEX}', $requestLimit, $embedding) YIELD node, score
     WHERE node.projectId = $pid AND ($type IS NULL OR node.type = $type)
     RETURN node, score
     ORDER BY score DESC
     LIMIT $limit`,
    { pid: pid(), type, embedding: vector, requestLimit: neo4j.int(requestLimit), limit: neo4j.int(limit) },
  );
  return records.map((record) => ({
    node: nodeFrom(record.get('node')),
    score: Number(record.get('score')),
  }));
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
  physicalEdges: number;
  nonRelPhysicalEdges: number;
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
  const physicalEdges = await one('MATCH (:Entity {projectId:$pid})-[r]->(:Entity {projectId:$pid}) RETURN count(r) AS c');
  const nonRelPhysicalEdges = await one("MATCH (:Entity {projectId:$pid})-[r]->(:Entity {projectId:$pid}) WHERE type(r) <> 'REL' RETURN count(r) AS c");
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
  return {
    nodes,
    edges,
    physicalEdges,
    nonRelPhysicalEdges,
    documents,
    chunks,
    assets,
    orphanNodes,
    orphanAssets,
    relatedToTotal,
    redundantRelatedTo,
    nonCanonicalKinds,
  };
}

export interface RepairResult {
  redundantRelatedToRetired: number;
  junkEdgesRemoved: number;
  orphanAssetsRemoved: number;
  nonRelPhysicalEdgesConverted: number;
  nonRelPhysicalEdgesRemoved: number;
  unresolvedNonRelPhysicalEdges: number;
  nonRelPhysicalEdgePlan: NonRelPhysicalEdgeRepairPlan;
  nonRelPhysicalEdgeApply?: {
    createdNew: number;
    mergedExisting: number;
    deletedOriginal: number;
    removedSelfLoop: number;
    removedLegacy: number;
  };
}

export async function repair(): Promise<RepairResult> {
  const audit = await auditGlobal();
  const nonRelPhysicalEdges = await listNonRelPhysicalEdges();
  const nonRelPhysicalEdgePlan = summarizeNonRelPhysicalEdgeRepair(nonRelPhysicalEdges);
  const result: RepairResult = {
    redundantRelatedToRetired: audit.redundantRelatedTo,
    junkEdgesRemoved: audit.nonCanonicalKinds.reduce((sum, row) => sum + row.count, 0),
    orphanAssetsRemoved: audit.orphanAssets,
    nonRelPhysicalEdgesConverted: nonRelPhysicalEdgePlan.converted,
    nonRelPhysicalEdgesRemoved: nonRelPhysicalEdgePlan.removed,
    unresolvedNonRelPhysicalEdges: nonRelPhysicalEdgePlan.unresolved,
    nonRelPhysicalEdgePlan,
  };
  if (nonRelPhysicalEdgePlan.unresolved > 0) {
    throw new Error(`repair_blocked: ${nonRelPhysicalEdgePlan.unresolved} unresolved non-REL physical edges`);
  }
  await run(
    `MATCH (a:Entity {projectId:$pid})-[r:REL {kind:'related_to'}]->(b:Entity {projectId:$pid})
     WHERE EXISTS { (a)-[typed:REL]-(b) WHERE typed.kind <> 'related_to' }
     DELETE r`,
    { pid: pid() },
  );
  await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) WHERE NOT r.kind IN $allowed DELETE r', { pid: pid(), allowed: KG_KINDS_LIST });
  await run('MATCH (a:Asset {projectId:$pid}) WHERE NOT (:Entity {projectId:$pid})-[:HAS_ASSET]->(a) DETACH DELETE a', { pid: pid() });
  result.nonRelPhysicalEdgeApply = await applyNonRelPhysicalEdgeRepair(nonRelPhysicalEdges);
  return result;
}

async function listNonRelPhysicalEdges(): Promise<NonRelPhysicalEdgeCandidate[]> {
  const records = await run(
    `MATCH (a:Entity {projectId:$pid})-[r]->(b:Entity {projectId:$pid})
     WHERE type(r) <> 'REL'
     RETURN elementId(r) AS relElementId,
       type(r) AS physicalType,
       coalesce(r.kind, '') AS rawKind,
       a.id AS fromId,
       b.id AS toId,
       a.type AS fromType,
       b.type AS toType,
       a.label AS fromLabel,
       b.label AS toLabel,
       coalesce(r.metadata, '') AS metadata,
       coalesce(r.provenance, '') AS provenance,
       r.id AS edgeId,
       r.weight AS weight,
       r.createdAt AS createdAt`,
    { pid: pid() },
  );
  return records.map((record) => ({
    relElementId: String(record.get('relElementId')),
    physicalType: String(record.get('physicalType')),
    rawKind: String(record.get('rawKind') ?? ''),
    fromId: String(record.get('fromId')),
    toId: String(record.get('toId')),
    fromType: String(record.get('fromType')),
    toType: String(record.get('toType')),
    fromLabel: String(record.get('fromLabel') ?? ''),
    toLabel: String(record.get('toLabel') ?? ''),
    metadata: String(record.get('metadata') ?? ''),
    provenance: String(record.get('provenance') ?? ''),
    edgeId: record.get('edgeId') == null ? undefined : String(record.get('edgeId')),
    weight: record.get('weight') == null ? undefined : Number(record.get('weight')),
    createdAt: record.get('createdAt') == null ? undefined : String(record.get('createdAt')),
  }));
}

async function relExists(fromId: string, toId: string, kind: string): Promise<boolean> {
  const records = await run(
    `MATCH (:Entity {projectId:$pid, id:$fromId})-[r:REL {kind:$kind}]->(:Entity {projectId:$pid, id:$toId})
     RETURN count(r) AS c`,
    { pid: pid(), fromId, toId, kind },
  );
  return records.length ? toInt(records[0].get('c')) > 0 : false;
}

async function applyNonRelPhysicalEdgeRepair(edges: NonRelPhysicalEdgeCandidate[]): Promise<NonRelPhysicalEdgeRepairResultApply> {
  const apply: NonRelPhysicalEdgeRepairResultApply = {
    createdNew: 0,
    mergedExisting: 0,
    deletedOriginal: 0,
    removedSelfLoop: 0,
    removedLegacy: 0,
  };
  for (const edge of edges) {
    const classification = classifyNonRelPhysicalEdge(edge);
    if (!edge.relElementId) continue;
    if (classification.action === 'unresolved') {
      throw new Error(`repair_blocked: unresolved non-REL physical edge ${edge.physicalType}/${edge.rawKind}/${edge.fromType}->${edge.toType}`);
    }
    if (classification.action === 'remove') {
      const deleted = await deleteNonRelPhysicalEdge(edge.relElementId);
      apply.deletedOriginal += deleted;
      if (classification.reason === 'self_loop_redundant') apply.removedSelfLoop += deleted;
      if (classification.reason === 'legacy_overgenerated_ally_of') apply.removedLegacy += deleted;
      continue;
    }
    const existed = await relExists(edge.fromId.trim(), edge.toId.trim(), classification.kind);
    const converted = await convertNonRelPhysicalEdge(edge, classification.kind);
    apply.deletedOriginal += converted.deletedOriginal;
    if (converted.deletedOriginal > 0) {
      if (existed) apply.mergedExisting++;
      else apply.createdNew++;
    }
  }
  return apply;
}

interface NonRelPhysicalEdgeRepairResultApply {
  createdNew: number;
  mergedExisting: number;
  deletedOriginal: number;
  removedSelfLoop: number;
  removedLegacy: number;
}

async function deleteNonRelPhysicalEdge(relElementId: string): Promise<number> {
  const records = await run(
    `MATCH ()-[r]->()
     WHERE elementId(r) = $relElementId AND type(r) <> 'REL'
     WITH r LIMIT 1
     DELETE r
     RETURN 1 AS c`,
    { relElementId },
  );
  return records.length ? 1 : 0;
}

async function convertNonRelPhysicalEdge(edge: NonRelPhysicalEdgeCandidate, kind: string): Promise<{ deletedOriginal: number }> {
  const records = await run(
    `MATCH (from:Entity {projectId:$pid, id:$fromId})-[old]->(to:Entity {projectId:$pid, id:$toId})
     WHERE elementId(old) = $relElementId AND type(old) <> 'REL'
     MERGE (from)-[rel:REL {kind:$kind}]->(to)
     ON CREATE SET rel.id = coalesce(old.id, $id),
       rel.weight = coalesce(old.weight, 1),
       rel.metadata = coalesce(old.metadata, '{}'),
       rel.provenance = coalesce(old.provenance, '{}'),
       rel.createdAt = coalesce(old.createdAt, $createdAt)
     ON MATCH SET rel.weight = CASE WHEN coalesce(rel.weight, 0) < coalesce(old.weight, 1) THEN coalesce(old.weight, 1) ELSE rel.weight END,
       rel.metadata = CASE
         WHEN old.metadata IS NULL OR old.metadata = '' OR old.metadata = '{}' THEN rel.metadata
         WHEN rel.metadata IS NULL OR rel.metadata = '' OR rel.metadata = '{}' THEN old.metadata
         WHEN rel.metadata = old.metadata THEN rel.metadata
         ELSE '{"existing":' + rel.metadata + ',"merged":' + old.metadata + '}'
       END,
       rel.provenance = CASE
         WHEN old.provenance IS NULL OR old.provenance = '' OR old.provenance = '{}' THEN rel.provenance
         WHEN rel.provenance IS NULL OR rel.provenance = '' OR rel.provenance = '{}' THEN old.provenance
         WHEN rel.provenance = old.provenance THEN rel.provenance
         ELSE '{"existing":' + rel.provenance + ',"merged":' + old.provenance + '}'
       END,
       rel.createdAt = coalesce(rel.createdAt, old.createdAt, $createdAt)
     WITH old
     DELETE old
     RETURN 1 AS c`,
    {
      pid: pid(),
      relElementId: edge.relElementId,
      fromId: edge.fromId.trim(),
      toId: edge.toId.trim(),
      kind,
      id: edge.edgeId || uuid(),
      createdAt: edge.createdAt || nowIso(),
    },
  );
  return { deletedOriginal: records.length ? 1 : 0 };
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
