import crypto from 'node:crypto';
import neo4j, { Driver, type ManagedTransaction, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';
import {
  decideWorkingDraftCas,
  normalizeWorkingDraftContent,
  retainWorkingDraftHistory,
  workingDraftContentHash,
  workingDraftWordCount,
  type WorkingDraftAuditStatus,
  type WorkingDraftAuthor,
  type WorkingDraftHistoryEntry,
  type WorkingDraftSnapshot,
} from '../novel/workingDraft.js';
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

export interface EmbeddingCandidateWithState extends EmbeddingCandidate {
  hasEmbedding: boolean;
}

export interface StoredNodeEmbedding {
  nodeId: string;
  vector: number[];
  textHash: string;
  model: string;
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
    embeddingIndexKnown = false;
    semanticSearchKnownReady = false;
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
  // The node was just fetched by key: apply the patch directly instead of re-reading it by id.
  const node = await applyNodePatch(existing, { content: input.content, metadata: input.metadata, provenance: input.provenance });
  return { node: node!, created: false };
}

export async function updateNode(id: string, patch: NodePatch): Promise<GraphNode | null> {
  const existing = await getNodeById(id);
  if (!existing) return null;
  return applyNodePatch(existing, patch);
}

async function applyNodePatch(existing: GraphNode, patch: NodePatch): Promise<GraphNode | null> {
  const id = existing.id;
  const nextType = patch.type?.trim() || existing.type;
  const nextLabel = patch.label?.trim() || existing.label;
  if (nextType !== existing.type || nextLabel !== existing.label) {
    const conflict = await getNodeByTypeLabel(nextType, nextLabel);
    if (conflict && conflict.id !== id) throw new Error(`node_key_conflict: ${nextType}/${nextLabel}`);
  }
  const metadata = patch.metadata ? mergeObj(existing.metadata, patch.metadata) : existing.metadata;
  const provenance = patch.provenance ? mergeObj(existing.provenance, patch.provenance) : existing.provenance;
  const nextContent = patch.content ?? existing.content;
  // Staleness detection: if the text an embedding would be computed from has changed since the
  // last time this node was embedded, clear the stored vector so it falls into the next
  // `listEmbeddingCandidates({missingOnly:true})` pass instead of silently going stale.
  const nextEmbeddingTextHash = embeddingTextHash(embeddingText({ type: nextType, label: nextLabel, content: nextContent, metadata }));
  const records = await run(
    `MATCH (n:Entity {id:$id, projectId:$pid})
     SET n.type=$type, n.label=$label, n.content=$content, n.metadata=$metadata, n.provenance=$provenance, n.updatedAt=$updatedAt
     SET n.embedding = CASE WHEN n.embeddingTextHash IS NULL OR n.embeddingTextHash <> $nextEmbeddingTextHash THEN null ELSE n.embedding END
     SET n.embeddingTextHash = $nextEmbeddingTextHash
     RETURN n`,
    {
      id,
      pid: pid(),
      type: nextType,
      label: nextLabel,
      content: nextContent,
      metadata: JSON.stringify(metadata),
      provenance: JSON.stringify(provenance),
      updatedAt: nowIso(),
      nextEmbeddingTextHash,
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

export async function getEdgeById(edgeId: string): Promise<GraphEdge | null> {
  const records = await run(
    `MATCH (a:Entity {projectId:$pid})-[r:REL {id:$edgeId}]->(b:Entity {projectId:$pid})
     RETURN r, a.id AS fromId, b.id AS toId LIMIT 1`,
    { edgeId, pid: pid() },
  );
  return records.length ? edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId'))) : null;
}

export async function link(input: EdgeInput): Promise<GraphEdge> {
  return (await linkWithStatus(input)).edge;
}

/**
 * Same as `link` but also reports whether the edge already existed. Endpoint existence and the
 * current edge are resolved in ONE round-trip (they used to be three separate lookups, and
 * `linkBulk` used to repeat all of them a second time before delegating here).
 */
export async function linkWithStatus(input: EdgeInput): Promise<{ edge: GraphEdge; merged: boolean }> {
  assertCanonicalKind(input.kind);
  const lookup = await run(
    `MATCH (a:Entity {id:$fromId, projectId:$pid}), (b:Entity {id:$toId, projectId:$pid})
     OPTIONAL MATCH (a)-[r:REL {kind:$kind}]->(b)
     RETURN r, a.id AS fromId, b.id AS toId`,
    { fromId: input.fromId, toId: input.toId, kind: input.kind, pid: pid() },
  );
  if (!lookup.length) throw new Error('node_not_found: fromId and toId must reference existing nodes');
  const existing = lookup[0].get('r') ? edgeFrom(lookup[0].get('r'), String(lookup[0].get('fromId')), String(lookup[0].get('toId'))) : null;
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
    return { edge: edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId'))), merged: true };
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
  return { edge: edgeFrom(records[0].get('r'), String(records[0].get('fromId')), String(records[0].get('toId'))), merged: false };
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
      // upsertNode already reports created-vs-merged: no need for a duplicate lookup by key.
      const written = await upsertNode(input);
      if (written.created) created++; else merged++;
      results.push({ type: input.type, label: input.label, status: written.created ? 'created' : 'merged', nodeId: written.node.id });
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
      // linkWithStatus resolves endpoints, existing edge, and the write itself in two
      // round-trips total (the old path repeated three lookups here and three more in link()).
      const written = await linkWithStatus(input);
      if (written.merged) merged++; else created++;
      results.push({ fromId: input.fromId, toId: input.toId, kind: input.kind, status: written.merged ? 'merged' : 'created', edgeId: written.edge.id });
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
  // Max 5000 (was 500): coverage/gate tools must see ALL canonical nodes of a type — a silent
  // 500 cap made bible coverage drift as soon as character_state passed 500 nodes.
  const limit = clampInt(opts.limit, 100, 1, 5000);
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

export async function recall(query: string, opts: { depth?: number; limit?: number; semanticSeeds?: GraphNode[] } = {}): Promise<{ matched: GraphNode[]; nodes: GraphNode[]; edges: GraphEdge[] }> {
  const lexical = await search(query, { limit: opts.limit ?? 8 });
  // Hybrid retrieval: callers can pass vector-search seeds so a query phrased differently from
  // the canon's wording still lands on the right nodes. Lexical matches keep priority in order.
  const seedMap = new Map<string, GraphNode>();
  for (const node of lexical) seedMap.set(node.id, node);
  for (const node of opts.semanticSeeds ?? []) if (!seedMap.has(node.id)) seedMap.set(node.id, node);
  const matched = [...seedMap.values()];
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  // Each match expands independently: run them concurrently on the driver's connection pool
  // instead of one at a time (merge order stays deterministic — results are merged in match order).
  const expansions = await Promise.all(matched.map((node) => neighbors(node.id, { depth: opts.depth ?? 1 })));
  for (const [index, node] of matched.entries()) {
    nodeMap.set(node.id, node);
    const expanded = expansions[index];
    for (const expandedNode of expanded.nodes) nodeMap.set(expandedNode.id, expandedNode);
    for (const edge of expanded.edges) edgeMap.set(edge.id, edge);
  }
  return { matched, nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

// Once the vector index is known to exist it never disappears on its own, so the positive
// answer is memoized: every semantic search and every inline embed used to pay a SHOW INDEXES
// (and a CREATE ... IF NOT EXISTS) round-trip per call for a fact that can only flip once.
let embeddingIndexKnown = false;

async function embeddingIndexExists(): Promise<boolean> {
  if (embeddingIndexKnown) return true;
  try {
    const records = await run(`SHOW INDEXES YIELD name WHERE name = '${ENTITY_EMBEDDING_INDEX}' RETURN count(*) AS c`, {});
    const exists = records.length ? toInt(records[0].get('c')) > 0 : false;
    if (exists) embeddingIndexKnown = true;
    return exists;
  } catch {
    return false;
  }
}

export async function createEmbeddingIndex(dimensions: number): Promise<void> {
  const dim = Math.trunc(dimensions);
  if (!Number.isFinite(dim) || dim <= 0 || dim > 8192) throw new Error('invalid_embedding_dimensions: dimensions must be between 1 and 8192');
  if (embeddingIndexKnown) return;
  await run(
    `CREATE VECTOR INDEX ${ENTITY_EMBEDDING_INDEX} IF NOT EXISTS FOR (n:Entity) ON (n.embedding)
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${dim}, \`vector.similarity_function\`: 'cosine' } }`,
    {},
  );
  embeddingIndexKnown = true;
}

// Same memoization idea for the "can semantic search run at all?" gate: once the index exists
// and at least one node is embedded, the gate stays open — embeddings are only ever cleared
// node-by-node on content change, never wholesale.
let semanticSearchKnownReady = false;

export async function semanticSearchReadiness(): Promise<{ ready: boolean; status: GraphEmbeddingStatus | null }> {
  if (semanticSearchKnownReady) return { ready: true, status: null };
  const status = await embeddingStatus();
  const ready = status.vectorIndexExists && status.embeddedNodes > 0;
  if (ready) semanticSearchKnownReady = true;
  return { ready, status };
}

export async function embeddingStatus(): Promise<GraphEmbeddingStatus> {
  const [records, vectorIndexExists] = await Promise.all([
    run(
      `MATCH (n:Entity {projectId:$pid})
       RETURN count(n) AS nodes,
         count(n.embedding) AS embeddedNodes,
         sum(CASE WHEN n.embedding IS NULL THEN 1 ELSE 0 END) AS pendingNodes,
         max(n.embeddingUpdatedAt) AS lastEmbeddedAt`,
      { pid: pid() },
    ),
    embeddingIndexExists(),
  ]);
  const record = records[0];
  return {
    vectorIndexName: ENTITY_EMBEDDING_INDEX,
    vectorIndexExists,
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

export async function listEmbeddingCandidates(opts: { type?: string; limit?: number; missingOnly?: boolean; model?: string } = {}): Promise<EmbeddingCandidate[]> {
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const type = opts.type?.trim() || null;
  const missingOnly = opts.missingOnly ?? true;
  // When the current model is provided, vectors produced by a different model count as missing:
  // after an embedding-model switch, `missingOnly:true` backfills automatically re-embed the
  // whole graph instead of silently mixing incompatible vector spaces in the same index.
  const model = opts.model?.trim() || null;
  const records = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE ($type IS NULL OR n.type = $type)
       AND ($missingOnly = false OR n.embedding IS NULL OR ($model IS NOT NULL AND n.embeddingModel <> $model))
     RETURN n
     ORDER BY coalesce(n.updatedAt, n.createdAt, '') DESC, n.label
     LIMIT $limit`,
    { pid: pid(), type, missingOnly, model, limit: neo4j.int(limit) },
  );
  return records.map((record) => embeddingCandidateFrom(record.get('n')));
}

/**
 * Fetches the embedding bookkeeping state for an explicit set of nodes in one round-trip, so the
 * inline post-commit embedder can decide (hash comparison) which nodes actually need the GPU.
 */
export async function getEmbeddingCandidatesByIds(nodeIds: string[]): Promise<EmbeddingCandidateWithState[]> {
  const uniqueIds = [...new Set(nodeIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const records = await run(
    `UNWIND $ids AS nodeId
     MATCH (n:Entity {id: nodeId, projectId: $pid})
     RETURN n, n.embedding IS NOT NULL AS hasEmbedding`,
    { ids: uniqueIds, pid: pid() },
  );
  return records.map((record) => ({
    ...embeddingCandidateFrom(record.get('n')),
    hasEmbedding: Boolean(record.get('hasEmbedding')),
  }));
}

/**
 * Reads already-stored vectors for a set of nodes in one round-trip. Callers that only need to
 * compare canonical nodes against each other (e.g. revision-impact neighbor checks) can reuse
 * these instead of re-embedding node content through the provider.
 */
export async function getNodeEmbeddings(nodeIds: string[]): Promise<Map<string, StoredNodeEmbedding>> {
  const uniqueIds = [...new Set(nodeIds.map((id) => id.trim()).filter(Boolean))];
  const result = new Map<string, StoredNodeEmbedding>();
  if (!uniqueIds.length) return result;
  const records = await run(
    `UNWIND $ids AS nodeId
     MATCH (n:Entity {id: nodeId, projectId: $pid})
     WHERE n.embedding IS NOT NULL
     RETURN n.id AS id, n.embedding AS embedding, coalesce(n.embeddingTextHash, '') AS textHash, coalesce(n.embeddingModel, '') AS model`,
    { ids: uniqueIds, pid: pid() },
  );
  for (const record of records) {
    const vector = record.get('embedding');
    if (!Array.isArray(vector) || !vector.length) continue;
    result.set(String(record.get('id')), {
      nodeId: String(record.get('id')),
      vector: vector.map((value) => Number(value)),
      textHash: String(record.get('textHash')),
      model: String(record.get('model')),
    });
  }
  return result;
}

/**
 * Persists a batch of embeddings in a single UNWIND write instead of one MATCH+SET per node.
 * Returns the number of nodes actually updated.
 */
export async function writeNodeEmbeddings(
  entries: Array<{ nodeId: string; vector: number[]; textHash: string }>,
  metadata: { provider: string; model: string; dimensions: number },
): Promise<number> {
  if (!entries.length) return 0;
  for (const entry of entries) {
    if (!entry.vector.length || entry.vector.some((value) => !Number.isFinite(value))) {
      throw new Error('invalid_embedding: vector must contain finite numbers');
    }
  }
  const records = await run(
    `UNWIND $rows AS row
     MATCH (n:Entity {id: row.nodeId, projectId: $pid})
     SET n.embedding = row.vector,
       n.embeddingProvider = $provider,
       n.embeddingModel = $model,
       n.embeddingDimensions = $dimensions,
       n.embeddingTextHash = row.textHash,
       n.embeddingUpdatedAt = $updatedAt
     RETURN count(n) AS c`,
    {
      rows: entries.map((entry) => ({ nodeId: entry.nodeId, vector: entry.vector, textHash: entry.textHash })),
      pid: pid(),
      provider: metadata.provider,
      model: metadata.model,
      dimensions: neo4j.int(metadata.dimensions),
      updatedAt: nowIso(),
    },
  );
  return records.length ? toInt(records[0].get('c')) : 0;
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

/** All project edges in one round-trip (the graph is small enough to load whole edge sets). */
export async function listProjectEdges(opts: { limit?: number } = {}): Promise<GraphEdge[]> {
  const limit = clampInt(opts.limit, 50_000, 1, 200_000);
  const records = await run(
    `MATCH (a:Entity {projectId:$pid})-[r:REL]->(b:Entity {projectId:$pid})
     RETURN r, a.id AS fromId, b.id AS toId LIMIT $limit`,
    { pid: pid(), limit: neo4j.int(limit) },
  );
  return records.map((record) => edgeFrom(record.get('r'), String(record.get('fromId')), String(record.get('toId'))));
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
  // Four independent aggregations: run them concurrently on the connection pool.
  const [nodeCountRecords, edgeCountRecords, nodeTypeRecords, edgeKindRecords] = await Promise.all([
    run('MATCH (n:Entity {projectId:$pid}) RETURN count(n) AS c', { pid: pid() }),
    run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN count(r) AS c', { pid: pid() }),
    run('MATCH (n:Entity {projectId:$pid}) RETURN n.type AS k, count(*) AS c ORDER BY c DESC', { pid: pid() }),
    run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN r.kind AS k, count(*) AS c ORDER BY c DESC', { pid: pid() }),
  ]);
  const nodeCount = toInt(nodeCountRecords[0]?.get('c') ?? 0);
  const edgeCount = toInt(edgeCountRecords[0]?.get('c') ?? 0);
  const nodeTypes: Record<string, number> = {};
  for (const record of nodeTypeRecords) {
    nodeTypes[String(record.get('k'))] = toInt(record.get('c'));
  }
  const edgeKinds: Record<string, number> = {};
  for (const record of edgeKindRecords) {
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
    chunkNodes.push(written.node);
  }
  // Structural edges (part_of + precedes) carry constant metadata/provenance, so the whole set
  // is written with a single UNWIND+MERGE round-trip instead of ~2 lookups + 1 write per edge.
  const provenanceJson = JSON.stringify({ source: 'kg_ingest_document', sourceId });
  const edgeRows = [
    ...chunkNodes.map((node) => ({ id: uuid(), fromId: node.id, toId: documentWrite.node.id, kind: 'part_of' })),
    ...chunkNodes.slice(0, -1).map((node, index) => ({ id: uuid(), fromId: node.id, toId: chunkNodes[index + 1].id, kind: 'precedes' })),
  ];
  if (edgeRows.length) {
    await run(
      `UNWIND $rows AS row
       MATCH (a:Entity {id: row.fromId, projectId: $pid}), (b:Entity {id: row.toId, projectId: $pid})
       MERGE (a)-[r:REL {kind: row.kind}]->(b)
       ON CREATE SET r.id = row.id, r.weight = 1, r.metadata = '{}', r.provenance = $provenance, r.createdAt = $ts`,
      { rows: edgeRows, pid: pid(), provenance: provenanceJson, ts: nowIso() },
    );
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

export interface WorkingDraftCasInput {
  chapterNumber: number;
  content: string;
  expectedContentHash: string;
  expectedRevision: number;
  author: WorkingDraftAuthor;
  clientMutationId?: string;
  changeSummary?: string;
}

export type WorkingDraftCasResult =
  | { status: 'updated'; draft: WorkingDraftSnapshot; previous: WorkingDraftSnapshot }
  | { status: 'unchanged'; draft: WorkingDraftSnapshot }
  | { status: 'conflict'; current: WorkingDraftSnapshot };

export interface WorkingDraftCleanupResult {
  draftNodes: number;
  documents: number;
  chunks: number;
  findings: number;
  assets: number;
}

export class WorkingDraftDocumentMissingError extends Error {
  readonly chapterNumber: number;

  constructor(chapterNumber: number) {
    super(`working_draft_document_missing: chapter ${chapterNumber}`);
    this.name = 'WorkingDraftDocumentMissingError';
    this.chapterNumber = chapterNumber;
  }
}

function workingDraftLabel(chapterNumber: number): string {
  return `Capitolo ${chapterNumber} draft`;
}

function asWorkingDraftAuthor(value: unknown): WorkingDraftAuthor {
  return value === 'ingest' || value === 'user' || value === 'llm' || value === 'system' ? value : 'system';
}

function workingDraftHistory(value: unknown): WorkingDraftHistoryEntry[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('working_draft_history_corrupt: invalid JSON');
    }
  }
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) throw new Error('working_draft_history_corrupt: expected an array');
  const history: WorkingDraftHistoryEntry[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object') throw new Error('working_draft_history_corrupt: invalid entry');
    const item = candidate as Partial<WorkingDraftHistoryEntry>;
    if (
      !Number.isInteger(item.revision) || Number(item.revision) < 1
      || typeof item.content !== 'string'
      || typeof item.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/i.test(item.contentHash)
    ) throw new Error('working_draft_history_corrupt: invalid entry fields');
    const normalizedContent = normalizeWorkingDraftContent(item.content);
    if (workingDraftContentHash(normalizedContent) !== item.contentHash.toLowerCase()) {
      throw new Error(`working_draft_history_corrupt: hash mismatch at revision ${item.revision}`);
    }
    const computedWordCount = workingDraftWordCount(normalizedContent);
    if (typeof item.wordCount === 'number' && item.wordCount !== computedWordCount) {
      throw new Error(`working_draft_history_corrupt: word count mismatch at revision ${item.revision}`);
    }
    if (typeof item.charCount === 'number' && item.charCount !== normalizedContent.length) {
      throw new Error(`working_draft_history_corrupt: char count mismatch at revision ${item.revision}`);
    }
    if (history.length && history[history.length - 1].revision + 1 !== Number(item.revision)) {
      throw new Error(`working_draft_history_corrupt: non-contiguous revision ${item.revision}`);
    }
    history.push({
      revision: Number(item.revision),
      content: normalizedContent,
      contentHash: item.contentHash.toLowerCase(),
      wordCount: computedWordCount,
      charCount: normalizedContent.length,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      updatedBy: asWorkingDraftAuthor(item.updatedBy),
      clientMutationId: typeof item.clientMutationId === 'string' ? item.clientMutationId : undefined,
      changeSummary: typeof item.changeSummary === 'string' ? item.changeSummary : undefined,
    });
  }
  return retainWorkingDraftHistory(history);
}

function archivedWorkingDraft(
  snapshot: WorkingDraftSnapshot,
  draftProps: Record<string, unknown>,
): WorkingDraftHistoryEntry {
  return {
    revision: snapshot.revision,
    content: snapshot.content,
    contentHash: snapshot.contentHash,
    wordCount: snapshot.wordCount,
    charCount: snapshot.charCount,
    updatedAt: snapshot.updatedAt,
    updatedBy: snapshot.updatedBy,
    clientMutationId: typeof draftProps.lastWorkingMutationId === 'string' ? draftProps.lastWorkingMutationId : undefined,
    changeSummary: typeof draftProps.lastWorkingChangeSummary === 'string' ? draftProps.lastWorkingChangeSummary : undefined,
  };
}

function workingDraftSnapshotFromNodes(chapterNumber: number, draft: Node, document: Node | null, chunks: Node[]): WorkingDraftSnapshot {
  const draftProps = draft.properties as Record<string, unknown>;
  const draftMetadata = safeJson(draftProps.metadata);
  const orderedChunks = chunks
    .map((chunk) => nodeFrom(chunk))
    .sort((a, b) => Number(a.metadata.order ?? 0) - Number(b.metadata.order ?? 0));
  const storedHash = String(draftProps.workingContentHash ?? '');
  const history = workingDraftHistory(draftProps.workingHistory);
  const legacyContent = orderedChunks.map((chunk) => chunk.content).join('\n\n');
  const content = normalizeWorkingDraftContent(storedHash ? String(draftProps.content ?? '') : legacyContent || String(draftProps.content ?? ''));
  const computedHash = workingDraftContentHash(content);
  if (storedHash && storedHash.toLowerCase() !== computedHash) {
    throw new Error(`working_draft_integrity_error: content/hash mismatch for chapter ${chapterNumber}`);
  }
  const contentHash = storedHash.toLowerCase() || computedHash;
  const revision = Math.max(1, toInt(draftProps.workingRevision ?? 1));
  if (history.some((entry, index) => entry.revision >= revision || (index > 0 && history[index - 1].revision >= entry.revision))) {
    throw new Error(`working_draft_history_corrupt: non-monotonic revisions for chapter ${chapterNumber}`);
  }
  if (history.length && history[history.length - 1].revision !== revision - 1) {
    throw new Error(`working_draft_history_corrupt: history does not precede revision ${revision} for chapter ${chapterNumber}`);
  }
  const sourceId = String(draftMetadata.sourceId ?? `chapter-${String(chapterNumber).padStart(3, '0')}-draft`);
  const documentProps = document?.properties as Record<string, unknown> | undefined;
  const rawAuditStatus = String(draftProps.workingAuditStatus ?? 'pending');
  const auditStatus: WorkingDraftAuditStatus = rawAuditStatus === 'passed' || rawAuditStatus === 'failed'
    ? rawAuditStatus
    : 'pending';
  const auditRevision = toInt(draftProps.workingAuditRevision ?? 0);
  return {
    chapterNumber,
    title: String(draftMetadata.title ?? `Capitolo ${chapterNumber}`),
    content,
    contentHash,
    revision,
    wordCount: workingDraftWordCount(content),
    charCount: content.length,
    updatedAt: String(draftProps.workingUpdatedAt ?? draftProps.updatedAt ?? ''),
    updatedBy: asWorkingDraftAuthor(draftProps.workingUpdatedBy),
    draftNodeId: String(draftProps.id),
    documentId: String(documentProps?.id ?? draftMetadata.documentId ?? ''),
    sourceId,
    retainedVersionCount: history.length + 1,
    auditStatus,
    auditContentHash: typeof draftProps.workingAuditContentHash === 'string' && draftProps.workingAuditContentHash
      ? draftProps.workingAuditContentHash.toLowerCase()
      : undefined,
    auditRevision: auditRevision > 0 ? auditRevision : undefined,
    auditAt: typeof draftProps.workingAuditAt === 'string' && draftProps.workingAuditAt ? draftProps.workingAuditAt : undefined,
    auditError: typeof draftProps.workingAuditError === 'string' && draftProps.workingAuditError ? draftProps.workingAuditError : undefined,
  };
}

async function queryWorkingDraft(
  runner: (cypher: string, params: Record<string, unknown>) => Promise<{ records: Neo4jRecord[] }>,
  chapterNumber: number,
  lockToken?: string,
): Promise<{ snapshot: WorkingDraftSnapshot; draft: Node; document: Node; chunks: Node[]; initialized: boolean } | null> {
  const lockClause = lockToken ? 'SET draft._workingDraftLock = $lockToken' : '';
  const result = await runner(
    `MATCH (draft:Entity {projectId:$pid, type:'chapter_draft', label:$label})
     ${lockClause}
     OPTIONAL MATCH (draft)-[:REL {kind:'derived_from'}]->(document:Entity {projectId:$pid, type:'document'})
     OPTIONAL MATCH (chunk:Entity {projectId:$pid, type:'chunk'})-[:REL {kind:'part_of'}]->(document)
     RETURN draft, document, collect(chunk) AS chunks`,
    { pid: pid(), label: workingDraftLabel(chapterNumber), lockToken: lockToken ?? null },
  );
  if (!result.records.length) return null;
  const record = result.records[0];
  const draft = record.get('draft') as Node;
  const document = record.get('document') as Node | null;
  if (!document) throw new WorkingDraftDocumentMissingError(chapterNumber);
  const chunks = ((record.get('chunks') as Array<Node | null>) ?? []).filter((chunk): chunk is Node => Boolean(chunk));
  const props = draft.properties as Record<string, unknown>;
  return {
    snapshot: workingDraftSnapshotFromNodes(chapterNumber, draft, document, chunks),
    draft,
    document,
    chunks,
    initialized: Boolean(String(props.workingContentHash ?? '')),
  };
}

export async function getWorkingDraft(chapterNumber: number): Promise<WorkingDraftSnapshot | null> {
  await ensureReady();
  const found = await queryWorkingDraft(async (cypher, params) => ({ records: await raw(cypher, params) }), chapterNumber);
  return found?.snapshot ?? null;
}

async function replaceWorkingDraftProjection(
  tx: ManagedTransaction,
  current: { snapshot: WorkingDraftSnapshot; draft: Node; document: Node },
  input: {
    content: string;
    revision: number;
    author: WorkingDraftAuthor;
    clientMutationId?: string;
    changeSummary?: string;
    updatedAt: string;
    archivePrevious: boolean;
  },
): Promise<WorkingDraftSnapshot> {
  const content = normalizeWorkingDraftContent(input.content);
  const contentHash = workingDraftContentHash(content);
  const wordCount = workingDraftWordCount(content);
  const draftProps = current.draft.properties as Record<string, unknown>;
  const storedHistory = workingDraftHistory(draftProps.workingHistory);
  const history = input.archivePrevious
    ? retainWorkingDraftHistory([...storedHistory, archivedWorkingDraft(current.snapshot, draftProps)])
    : storedHistory;
  const documentProps = current.document.properties as Record<string, unknown>;
  const draftMetadata = {
    ...safeJson(draftProps.metadata),
    contentHash,
    revision: input.revision,
    wordCount,
    charCount: content.length,
    updatedBy: input.author,
    updatedAt: input.updatedAt,
  };
  const documentMetadata = {
    ...safeJson(documentProps.metadata),
    contentHash,
    revision: input.revision,
    chunkCount: chunkText(content).length,
    updatedAt: input.updatedAt,
  };
  await tx.run(
    `MATCH (draft:Entity {projectId:$pid, id:$draftId}), (document:Entity {projectId:$pid, id:$documentId})
     SET draft.content=$content,
         draft.metadata=$draftMetadata,
         draft.workingContentHash=$contentHash,
         draft.workingRevision=$revision,
         draft.workingUpdatedAt=$updatedAt,
         draft.workingUpdatedBy=$author,
         draft.lastWorkingMutationId=$clientMutationId,
         draft.lastWorkingChangeSummary=$changeSummary,
         draft.workingHistory=$workingHistory,
         draft.workingAuditStatus='pending',
         draft.workingAuditContentHash=null,
         draft.workingAuditRevision=null,
         draft.workingAuditAt=null,
         draft.workingAuditError=null,
         draft.updatedAt=$updatedAt,
         draft.embedding=null,
         draft.embeddingTextHash=null
     REMOVE draft._workingDraftLock
     SET document.metadata=$documentMetadata,
         document.updatedAt=$updatedAt,
         document.embedding=null,
         document.embeddingTextHash=null`,
    {
      pid: pid(),
      draftId: current.snapshot.draftNodeId,
      documentId: current.snapshot.documentId,
      content,
      draftMetadata: JSON.stringify(draftMetadata),
      documentMetadata: JSON.stringify(documentMetadata),
      contentHash,
      revision: neo4j.int(input.revision),
      updatedAt: input.updatedAt,
      author: input.author,
      clientMutationId: input.clientMutationId ?? null,
      changeSummary: input.changeSummary ?? null,
      workingHistory: JSON.stringify(history),
    },
  );

  await tx.run(
    `MATCH (document:Entity {projectId:$pid, id:$documentId})
     OPTIONAL MATCH (chunk:Entity {projectId:$pid, type:'chunk'})-[:REL {kind:'part_of'}]->(document)
     OPTIONAL MATCH (chunk)-[:HAS_ASSET]->(asset:Asset {projectId:$pid})
     WITH [item IN collect(DISTINCT asset) WHERE item IS NOT NULL] AS assets,
          [item IN collect(DISTINCT chunk) WHERE item IS NOT NULL] AS chunks
     FOREACH (asset IN assets | DETACH DELETE asset)
     FOREACH (chunk IN chunks | DETACH DELETE chunk)`,
    { pid: pid(), documentId: current.snapshot.documentId },
  );

  const sourceId = current.snapshot.sourceId;
  const title = current.snapshot.title;
  const provenance = JSON.stringify({ source: 'working_draft_update', sourceId, chapterNumber: current.snapshot.chapterNumber, author: input.author });
  const rows = chunkText(content).map((text, index, all) => {
    const id = uuid();
    return {
      id,
      nextId: index < all.length - 1 ? '' : null,
      label: `${sourceId}#${String(index + 1).padStart(5, '0')}`,
      content: text,
      metadata: JSON.stringify({
        sourceId,
        sourceType: 'chapter_draft',
        documentId: current.snapshot.documentId,
        documentLabel: sourceId,
        title,
        order: index + 1,
        chapterNumber: current.snapshot.chapterNumber,
        revision: input.revision,
        contentHash,
      }),
    };
  });
  for (let index = 0; index < rows.length - 1; index++) rows[index].nextId = rows[index + 1].id;
  if (rows.length) {
    await tx.run(
      `MATCH (document:Entity {projectId:$pid, id:$documentId})
       UNWIND $rows AS row
       CREATE (chunk:Entity {
         id:row.id, projectId:$pid, type:'chunk', label:row.label, content:row.content,
         metadata:row.metadata, provenance:$provenance, createdAt:$updatedAt, updatedAt:$updatedAt,
         draftRevision:$revision, contentHash:$contentHash
       })
       CREATE (chunk)-[:REL {
         id:randomUUID(), kind:'part_of', weight:1, metadata:'{}', provenance:$provenance, createdAt:$updatedAt
       }]->(document)`,
      {
        pid: pid(),
        documentId: current.snapshot.documentId,
        rows,
        provenance,
        updatedAt: input.updatedAt,
        revision: neo4j.int(input.revision),
        contentHash,
      },
    );
    await tx.run(
      `UNWIND [row IN $rows WHERE row.nextId IS NOT NULL] AS row
       MATCH (chunk:Entity {projectId:$pid, id:row.id}), (next:Entity {projectId:$pid, id:row.nextId})
       CREATE (chunk)-[:REL {
         id:randomUUID(), kind:'precedes', weight:1, metadata:'{}', provenance:$provenance, createdAt:$updatedAt
       }]->(next)`,
      { pid: pid(), rows, provenance, updatedAt: input.updatedAt },
    );
  }

  return {
    ...current.snapshot,
    content,
    contentHash,
    revision: input.revision,
    wordCount,
    charCount: content.length,
    updatedAt: input.updatedAt,
    updatedBy: input.author,
    retainedVersionCount: history.length + 1,
    auditStatus: 'pending',
    auditContentHash: undefined,
    auditRevision: undefined,
    auditAt: undefined,
    auditError: undefined,
  };
}

export async function initializeWorkingDraftProjection(input: {
  chapterNumber: number;
  content: string;
  author?: WorkingDraftAuthor;
}): Promise<WorkingDraftSnapshot> {
  await ensureReady();
  const session = getDriver().session();
  try {
    return await session.executeWrite(async (tx) => {
      const current = await queryWorkingDraft((cypher, params) => tx.run(cypher, params), input.chapterNumber, uuid());
      if (!current) throw new Error(`working_draft_not_found: chapter ${input.chapterNumber}`);
      const proposedContent = normalizeWorkingDraftContent(input.content);
      const proposedHash = workingDraftContentHash(proposedContent);
      if (current.initialized && current.snapshot.contentHash !== proposedHash) {
        await tx.run('MATCH (draft:Entity {projectId:$pid, id:$draftId}) REMOVE draft._workingDraftLock', {
          pid: pid(),
          draftId: current.snapshot.draftNodeId,
        });
        throw new Error(`draft_version_conflict: current=${current.snapshot.contentHash}`);
      }
      return replaceWorkingDraftProjection(tx, current, {
        content: proposedContent,
        revision: current.initialized ? current.snapshot.revision : 1,
        author: input.author ?? 'ingest',
        updatedAt: nowIso(),
        archivePrevious: false,
      });
    });
  } finally {
    await session.close();
  }
}

export async function compareAndSwapWorkingDraft(input: WorkingDraftCasInput): Promise<WorkingDraftCasResult> {
  await ensureReady();
  const content = normalizeWorkingDraftContent(input.content);
  if (!content.trim()) throw new Error('invalid_working_draft: content is required');
  const session = getDriver().session();
  try {
    return await session.executeWrite(async (tx) => {
      const current = await queryWorkingDraft((cypher, params) => tx.run(cypher, params), input.chapterNumber, uuid());
      if (!current) throw new Error(`working_draft_not_found: chapter ${input.chapterNumber}`);
      const proposedHash = workingDraftContentHash(content);
      const draftProps = current.draft.properties as Record<string, unknown>;
      const lastMutationId = String(draftProps.lastWorkingMutationId ?? '');
      const decision = decideWorkingDraftCas({
        currentContentHash: current.snapshot.contentHash,
        currentRevision: current.snapshot.revision,
        lastMutationId,
        proposedContentHash: proposedHash,
        expectedContentHash: input.expectedContentHash,
        expectedRevision: input.expectedRevision,
        clientMutationId: input.clientMutationId,
      });
      if (decision !== 'update') {
        await tx.run('MATCH (draft:Entity {projectId:$pid, id:$draftId}) REMOVE draft._workingDraftLock', {
          pid: pid(),
          draftId: current.snapshot.draftNodeId,
        });
        if (decision === 'unchanged') return { status: 'unchanged', draft: current.snapshot };
        return { status: 'conflict', current: current.snapshot };
      }
      const draft = await replaceWorkingDraftProjection(tx, current, {
        content,
        revision: current.snapshot.revision + 1,
        author: input.author,
        clientMutationId: input.clientMutationId,
        changeSummary: input.changeSummary,
        updatedAt: nowIso(),
        archivePrevious: true,
      });
      return { status: 'updated', draft, previous: current.snapshot };
    });
  } finally {
    await session.close();
  }
}

/**
 * Records the autonomous linter outcome only when it still refers to the exact current draft.
 * This prevents a slow audit from blessing text that changed while the audit was running.
 */
export async function markWorkingDraftAudit(input: {
  chapterNumber: number;
  expectedContentHash: string;
  expectedRevision: number;
  status: Exclude<WorkingDraftAuditStatus, 'pending'>;
  error?: string;
}): Promise<WorkingDraftSnapshot> {
  await ensureReady();
  const session = getDriver().session();
  try {
    return await session.executeWrite(async (tx) => {
      const current = await queryWorkingDraft((cypher, params) => tx.run(cypher, params), input.chapterNumber, uuid());
      if (!current) throw new Error(`working_draft_not_found: chapter ${input.chapterNumber}`);
      if (
        current.snapshot.contentHash !== input.expectedContentHash.toLowerCase()
        || current.snapshot.revision !== input.expectedRevision
      ) {
        await tx.run('MATCH (draft:Entity {projectId:$pid, id:$draftId}) REMOVE draft._workingDraftLock', {
          pid: pid(),
          draftId: current.snapshot.draftNodeId,
        });
        throw new Error(`working_draft_audit_stale: chapter ${input.chapterNumber}`);
      }
      const auditedAt = nowIso();
      await tx.run(
        `MATCH (draft:Entity {projectId:$pid, id:$draftId})
         WHERE draft.workingContentHash=$contentHash AND draft.workingRevision=$revision
         SET draft.workingAuditStatus=$status,
             draft.workingAuditContentHash=$contentHash,
             draft.workingAuditRevision=$revision,
             draft.workingAuditAt=$auditedAt,
             draft.workingAuditError=$auditError,
             draft.updatedAt=$auditedAt
         REMOVE draft._workingDraftLock
         RETURN draft.id AS id`,
        {
          pid: pid(),
          draftId: current.snapshot.draftNodeId,
          contentHash: current.snapshot.contentHash,
          revision: neo4j.int(current.snapshot.revision),
          status: input.status,
          auditedAt,
          auditError: input.error?.slice(0, 4000) ?? null,
        },
      ).then((result) => {
        if (!result.records.length) throw new Error(`working_draft_audit_stale: chapter ${input.chapterNumber}`);
      });
      return {
        ...current.snapshot,
        auditStatus: input.status,
        auditContentHash: current.snapshot.contentHash,
        auditRevision: current.snapshot.revision,
        auditAt: auditedAt,
        auditError: input.error?.slice(0, 4000),
      };
    });
  } finally {
    await session.close();
  }
}

export async function listWorkingDraftFindings(chapterNumber: number): Promise<GraphNode[]> {
  await ensureReady();
  const sourceId = `chapter-${String(chapterNumber).padStart(3, '0')}-draft`;
  const records = await run(
    `MATCH (finding:Entity {projectId:$pid, type:'continuity_finding'})
     WHERE finding.provenance CONTAINS $linterSourceMarker
       AND finding.provenance CONTAINS $draftSourceMarker
       AND finding.metadata CONTAINS $draftOwnedMarker
     RETURN DISTINCT finding ORDER BY finding.createdAt`,
    {
      pid: pid(),
      linterSourceMarker: '"source":"autonomous_ingest_linter"',
      draftSourceMarker: `"sourceId":"${sourceId}"`,
      draftOwnedMarker: '"draftOwned":true',
    },
  );
  return records.map((record) => nodeFrom(record.get('finding')));
}

export async function clearWorkingDraftLinterFindings(chapterNumber: number): Promise<number> {
  await ensureReady();
  const sourceId = `chapter-${String(chapterNumber).padStart(3, '0')}-draft`;
  const records = await run(
    `MATCH (finding:Entity {projectId:$pid, type:'continuity_finding'})
     WHERE finding.provenance CONTAINS $linterSourceMarker
       AND finding.provenance CONTAINS $draftSourceMarker
     WITH collect(DISTINCT finding) AS findings
     WITH findings, size(findings) AS deleted
     FOREACH (finding IN findings | DETACH DELETE finding)
     RETURN deleted`,
    {
      pid: pid(),
      linterSourceMarker: '"source":"autonomous_ingest_linter"',
      draftSourceMarker: `"sourceId":"${sourceId}"`,
    },
  );
  return records.length ? toInt(records[0].get('deleted')) : 0;
}

export async function cleanupWorkingDraftArtifacts(chapterNumber: number): Promise<WorkingDraftCleanupResult> {
  await ensureReady();
  const sourceId = `chapter-${String(chapterNumber).padStart(3, '0')}-draft`;
  const chunkPrefix = `${sourceId}#`;
  const records = await run(
    `OPTIONAL MATCH (draft:Entity {projectId:$pid, type:'chapter_draft', label:$label})
     OPTIONAL MATCH (document:Entity {projectId:$pid, type:'document', label:$sourceId})
     OPTIONAL MATCH (chunk:Entity {projectId:$pid, type:'chunk'})
       WHERE chunk.label STARTS WITH $chunkPrefix
          OR (document IS NOT NULL AND (chunk)-[:REL {kind:'part_of'}]->(document))
     OPTIONAL MATCH (asset:Asset {projectId:$pid})
       WHERE asset.nodeId IN [draft.id, document.id, chunk.id]
     OPTIONAL MATCH (finding:Entity {projectId:$pid, type:'continuity_finding'})
       WHERE finding.provenance CONTAINS $linterSourceMarker
         AND finding.provenance CONTAINS $draftSourceMarker
         AND finding.metadata CONTAINS $draftOwnedMarker
     WITH [item IN collect(DISTINCT asset) WHERE item IS NOT NULL] AS assets,
          [item IN collect(DISTINCT finding) WHERE item IS NOT NULL] AS findings,
          [item IN collect(DISTINCT chunk) WHERE item IS NOT NULL] AS chunks,
          [item IN collect(DISTINCT document) WHERE item IS NOT NULL] AS documents,
          [item IN collect(DISTINCT draft) WHERE item IS NOT NULL] AS drafts
     WITH assets, findings, chunks, documents, drafts,
          size(assets) AS assetCount, size(findings) AS findingCount, size(chunks) AS chunkCount,
          size(documents) AS documentCount, size(drafts) AS draftCount
     FOREACH (item IN assets | DETACH DELETE item)
     FOREACH (item IN findings | DETACH DELETE item)
     FOREACH (item IN chunks | DETACH DELETE item)
     FOREACH (item IN documents | DETACH DELETE item)
     FOREACH (item IN drafts | DETACH DELETE item)
     RETURN assetCount, findingCount, chunkCount, documentCount, draftCount`,
    {
      pid: pid(),
      label: workingDraftLabel(chapterNumber),
      sourceId,
      chunkPrefix,
      linterSourceMarker: '"source":"autonomous_ingest_linter"',
      draftSourceMarker: `"sourceId":"${sourceId}"`,
      draftOwnedMarker: '"draftOwned":true',
    },
  );
  if (!records.length) return { draftNodes: 0, documents: 0, chunks: 0, findings: 0, assets: 0 };
  return {
    draftNodes: toInt(records[0].get('draftCount')),
    documents: toInt(records[0].get('documentCount')),
    chunks: toInt(records[0].get('chunkCount')),
    findings: toInt(records[0].get('findingCount')),
    assets: toInt(records[0].get('assetCount')),
  };
}

export async function listDocuments(opts: { sourceType?: string; limit?: number } = {}): Promise<GraphNode[]> {
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run("MATCH (n:Entity {projectId:$pid, type:'document'}) RETURN n ORDER BY n.updatedAt DESC LIMIT $limit", { pid: pid(), limit: neo4j.int(limit) });
  const docs = records.map((record) => nodeFrom(record.get('n')));
  return opts.sourceType ? docs.filter((doc) => doc.metadata.sourceType === opts.sourceType) : docs;
}

export interface RecentChangesResult {
  since: string;
  createdNodes: GraphNode[];
  updatedNodes: GraphNode[];
  createdEdges: GraphEdge[];
  totals: { createdNodes: number; updatedNodes: number; createdEdges: number };
  truncated: boolean;
}

/**
 * Perception layer for the cognitive loop: everything created or updated in the graph since a
 * given instant. Timestamps are ISO-8601 strings, so plain string comparison is a correct
 * chronological order. A node whose createdAt >= since is "created"; one only touched after
 * `since` is "updated".
 */
export async function recentChanges(opts: { since: string; types?: string[]; limit?: number; includeEdges?: boolean }): Promise<RecentChangesResult> {
  const since = opts.since.trim();
  if (!since) throw new Error('invalid_since: an ISO-8601 timestamp is required');
  const limit = clampInt(opts.limit, 200, 1, 500);
  const types = opts.types?.map((type) => type.trim()).filter(Boolean) ?? null;
  const nodeRecords = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE coalesce(n.updatedAt, n.createdAt, '') >= $since
       AND ($types IS NULL OR n.type IN $types)
     RETURN n ORDER BY coalesce(n.updatedAt, n.createdAt, '') DESC LIMIT $limit`,
    { pid: pid(), since, types: types?.length ? types : null, limit: neo4j.int(limit + 1) },
  );
  const nodes = nodeRecords.map((record) => nodeFrom(record.get('n')));
  const truncatedNodes = nodes.length > limit;
  const bounded = truncatedNodes ? nodes.slice(0, limit) : nodes;
  const createdNodes = bounded.filter((node) => node.createdAt >= since);
  const updatedNodes = bounded.filter((node) => node.createdAt < since);

  let createdEdges: GraphEdge[] = [];
  let truncatedEdges = false;
  if (opts.includeEdges !== false) {
    const edgeRecords = await run(
      `MATCH (a:Entity {projectId:$pid})-[r:REL]->(b:Entity {projectId:$pid})
       WHERE coalesce(r.createdAt, '') >= $since
       RETURN r, a.id AS fromId, b.id AS toId ORDER BY r.createdAt DESC LIMIT $limit`,
      { pid: pid(), since, limit: neo4j.int(limit + 1) },
    );
    createdEdges = edgeRecords.map((record) => edgeFrom(record.get('r'), String(record.get('fromId')), String(record.get('toId'))));
    truncatedEdges = createdEdges.length > limit;
    if (truncatedEdges) createdEdges = createdEdges.slice(0, limit);
  }

  return {
    since,
    createdNodes,
    updatedNodes,
    createdEdges,
    totals: { createdNodes: createdNodes.length, updatedNodes: updatedNodes.length, createdEdges: createdEdges.length },
    truncated: truncatedNodes || truncatedEdges,
  };
}
