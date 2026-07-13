import crypto from 'node:crypto';
import neo4j, { Driver, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';
import type { GraphEdge, GraphNode } from './neo4jReadService.js';

export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 'romanzo-gabriele.graph-snapshot.v1';

const WORKING_DRAFT_HISTORY_LIMIT = 19;
const WORKING_DRAFT_HASH_PATTERN = /^[a-f0-9]{64}$/i;
const WORKING_DRAFT_AUTHORS = new Set(['ingest', 'user', 'llm', 'system']);

/**
 * Mutable working-draft state lives on the chapter_draft node rather than in
 * its generic metadata. Keep it in the snapshot so a restore does not reset
 * or desynchronise optimistic-concurrency state.
 */
export interface WorkingDraftSnapshotFields {
  workingHistory?: string;
  workingRevision?: number;
  workingContentHash?: string;
  workingUpdatedAt?: string;
  workingUpdatedBy?: string;
  lastWorkingMutationId?: string;
  lastWorkingChangeSummary?: string;
  workingAuditStatus?: string;
  workingAuditContentHash?: string;
  workingAuditRevision?: number;
  workingAuditAt?: string;
  workingAuditError?: string;
}

export type SnapshotGraphNode = GraphNode & WorkingDraftSnapshotFields;

export interface GraphSnapshot {
  schemaVersion: typeof GRAPH_SNAPSHOT_SCHEMA_VERSION;
  projectId: string;
  exportedAt: string;
  appVersion: string;
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: SnapshotGraphNode[];
  edges: GraphEdge[];
}

export type ImportMode = 'upsert' | 'replaceProject';

export interface SnapshotValidationReport {
  ok: boolean;
  schemaVersion?: string;
  sourceProjectId?: string;
  targetProjectId: string;
  mode: ImportMode;
  dryRun: boolean;
  counts: {
    nodes: number;
    edges: number;
    currentNodes: number;
    currentEdges: number;
  };
  errors: string[];
  warnings: string[];
}

export interface SnapshotImportResult {
  ok: boolean;
  dryRun: boolean;
  mode: ImportMode;
  report: SnapshotValidationReport;
  written?: {
    nodes: number;
    edges: number;
  };
}

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), {
      maxConnectionPoolSize: 10,
    });
  }
  return driver;
}

async function runRead(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(cypher, params);
    return res.records;
  } finally {
    await session.close();
  }
}

function safeJson(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
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

function stringProp(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return value == null ? '' : String(value);
}

function optionalStringProp(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return value == null ? undefined : String(value);
}

export function workingDraftSnapshotFieldsFromProperties(props: Record<string, unknown>): WorkingDraftSnapshotFields {
  const rawRevision = props.workingRevision;
  const workingRevision = rawRevision == null ? undefined : toInt(rawRevision);
  const workingHistory = optionalStringProp(props, 'workingHistory');
  const workingContentHash = optionalStringProp(props, 'workingContentHash');
  const workingUpdatedAt = optionalStringProp(props, 'workingUpdatedAt');
  const workingUpdatedBy = optionalStringProp(props, 'workingUpdatedBy');
  const lastWorkingMutationId = optionalStringProp(props, 'lastWorkingMutationId');
  const lastWorkingChangeSummary = optionalStringProp(props, 'lastWorkingChangeSummary');
  const workingAuditStatus = optionalStringProp(props, 'workingAuditStatus');
  const workingAuditContentHash = optionalStringProp(props, 'workingAuditContentHash');
  const rawAuditRevision = props.workingAuditRevision;
  const workingAuditRevision = rawAuditRevision == null ? undefined : toInt(rawAuditRevision);
  const workingAuditAt = optionalStringProp(props, 'workingAuditAt');
  const workingAuditError = optionalStringProp(props, 'workingAuditError');
  return {
    ...(workingHistory !== undefined ? { workingHistory } : {}),
    ...(workingRevision !== undefined ? { workingRevision } : {}),
    ...(workingContentHash !== undefined ? { workingContentHash } : {}),
    ...(workingUpdatedAt !== undefined ? { workingUpdatedAt } : {}),
    ...(workingUpdatedBy !== undefined ? { workingUpdatedBy } : {}),
    ...(lastWorkingMutationId !== undefined ? { lastWorkingMutationId } : {}),
    ...(lastWorkingChangeSummary !== undefined ? { lastWorkingChangeSummary } : {}),
    ...(workingAuditStatus !== undefined ? { workingAuditStatus } : {}),
    ...(workingAuditContentHash !== undefined ? { workingAuditContentHash } : {}),
    ...(workingAuditRevision !== undefined ? { workingAuditRevision } : {}),
    ...(workingAuditAt !== undefined ? { workingAuditAt } : {}),
    ...(workingAuditError !== undefined ? { workingAuditError } : {}),
  };
}

function nodeFrom(node: Node): SnapshotGraphNode {
  const props = node.properties as Record<string, unknown>;
  return {
    id: stringProp(props, 'id'),
    type: stringProp(props, 'type'),
    label: stringProp(props, 'label'),
    content: stringProp(props, 'content'),
    metadata: safeJson(props.metadata),
    provenance: safeJson(props.provenance),
    createdAt: stringProp(props, 'createdAt'),
    updatedAt: stringProp(props, 'updatedAt'),
    ...workingDraftSnapshotFieldsFromProperties(props),
  };
}

function edgeFrom(rel: Relationship, fromId: string, toId: string): GraphEdge {
  const props = rel.properties as Record<string, unknown>;
  return {
    id: stringProp(props, 'id'),
    fromId,
    toId,
    kind: stringProp(props, 'kind'),
    weight: Number(props.weight ?? 1),
    metadata: safeJson(props.metadata),
    provenance: safeJson(props.provenance),
    createdAt: stringProp(props, 'createdAt'),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isGraphNode(value: unknown): value is SnapshotGraphNode {
  if (!isPlainObject(value)) return false;
  return ['id', 'type', 'label', 'content', 'createdAt', 'updatedAt'].every((key) => typeof value[key] === 'string')
    && isPlainObject(value.metadata)
    && isPlainObject(value.provenance);
}

function normalizeWorkingDraftContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function workingDraftContentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeWorkingDraftContent(content), 'utf8').digest('hex');
}

function validateWorkingDraftHistory(rawHistory: string, currentRevision: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawHistory) as unknown;
  } catch {
    return ['working_history_invalid_json'];
  }
  if (!Array.isArray(parsed)) return ['working_history_must_be_array'];
  if (parsed.length > WORKING_DRAFT_HISTORY_LIMIT) return ['working_history_exceeds_retention_limit'];

  const errors: string[] = [];
  let previousRevision: number | null = null;
  parsed.forEach((candidate, index) => {
    if (!isPlainObject(candidate)) {
      errors.push(`working_history_invalid_entry_${index}`);
      return;
    }
    const revision = candidate.revision;
    const content = candidate.content;
    const contentHash = candidate.contentHash;
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
      errors.push(`working_history_invalid_revision_${index}`);
      return;
    }
    if (Number(revision) >= currentRevision || (previousRevision !== null && Number(revision) !== previousRevision + 1)) {
      errors.push(`working_history_non_monotonic_revision_${index}`);
    }
    previousRevision = Number(revision);
    if (typeof content !== 'string' || typeof contentHash !== 'string' || !WORKING_DRAFT_HASH_PATTERN.test(contentHash)) {
      errors.push(`working_history_invalid_content_${index}`);
      return;
    }
    if (workingDraftContentHash(content) !== contentHash.toLowerCase()) {
      errors.push(`working_history_hash_mismatch_${index}`);
    }
    const normalizedContent = normalizeWorkingDraftContent(content);
    const computedWords = normalizedContent.trim().split(/\s+/u).filter(Boolean).length;
    if (candidate.wordCount !== undefined && candidate.wordCount !== computedWords) {
      errors.push(`working_history_word_count_mismatch_${index}`);
    }
    if (candidate.charCount !== undefined && candidate.charCount !== normalizedContent.length) {
      errors.push(`working_history_char_count_mismatch_${index}`);
    }
  });
  if (parsed.length && previousRevision !== currentRevision - 1) errors.push('working_history_does_not_precede_current');
  return errors;
}

/** Validate the CAS/history state without touching Neo4j (also used by tests). */
export function validateWorkingDraftSnapshotNode(node: SnapshotGraphNode): string[] {
  const fields: Array<keyof WorkingDraftSnapshotFields> = [
    'workingHistory',
    'workingRevision',
    'workingContentHash',
    'workingUpdatedAt',
    'workingUpdatedBy',
    'lastWorkingMutationId',
    'lastWorkingChangeSummary',
    'workingAuditStatus',
    'workingAuditContentHash',
    'workingAuditRevision',
    'workingAuditAt',
    'workingAuditError',
  ];
  const hasWorkingState = fields.some((key) => node[key] !== undefined && node[key] !== null);
  if (!hasWorkingState) return [];

  const errors: string[] = [];
  if (node.type !== 'chapter_draft') errors.push('working_state_on_non_chapter_draft');

  if (!Number.isSafeInteger(node.workingRevision) || Number(node.workingRevision) < 1) {
    errors.push('working_revision_invalid');
  }
  if (typeof node.workingContentHash !== 'string' || !WORKING_DRAFT_HASH_PATTERN.test(node.workingContentHash)) {
    errors.push('working_content_hash_invalid');
  } else if (workingDraftContentHash(node.content) !== node.workingContentHash.toLowerCase()) {
    errors.push('working_content_hash_mismatch');
  }

  const optionalStringFields: Array<Exclude<keyof WorkingDraftSnapshotFields, 'workingRevision' | 'workingAuditRevision' | 'workingContentHash'>> = [
    'workingHistory',
    'workingUpdatedAt',
    'workingUpdatedBy',
    'lastWorkingMutationId',
    'lastWorkingChangeSummary',
    'workingAuditStatus',
    'workingAuditContentHash',
    'workingAuditAt',
    'workingAuditError',
  ];
  for (const key of optionalStringFields) {
    const value = node[key];
    if (value !== undefined && value !== null && typeof value !== 'string') errors.push(`${key}_must_be_string`);
  }
  if (typeof node.workingUpdatedBy === 'string' && !WORKING_DRAFT_AUTHORS.has(node.workingUpdatedBy)) {
    errors.push('working_updated_by_invalid');
  }
  if (node.workingAuditStatus !== undefined && !['pending', 'passed', 'failed'].includes(node.workingAuditStatus)) {
    errors.push('working_audit_status_invalid');
  }
  if (node.workingAuditRevision !== undefined && (!Number.isSafeInteger(node.workingAuditRevision) || Number(node.workingAuditRevision) < 1)) {
    errors.push('working_audit_revision_invalid');
  }
  if (node.workingAuditContentHash !== undefined && !WORKING_DRAFT_HASH_PATTERN.test(node.workingAuditContentHash)) {
    errors.push('working_audit_content_hash_invalid');
  }
  if (node.workingAuditStatus === 'passed' || node.workingAuditStatus === 'failed') {
    if (node.workingAuditContentHash?.toLowerCase() !== node.workingContentHash?.toLowerCase()) {
      errors.push('working_audit_content_hash_mismatch');
    }
    if (node.workingAuditRevision !== node.workingRevision) errors.push('working_audit_revision_mismatch');
  }
  if (typeof node.workingHistory === 'string' && Number.isSafeInteger(node.workingRevision)) {
    errors.push(...validateWorkingDraftHistory(node.workingHistory, Number(node.workingRevision)));
  }
  return errors;
}

function isGraphEdge(value: unknown): value is GraphEdge {
  if (!isPlainObject(value)) return false;
  return ['id', 'fromId', 'toId', 'kind', 'createdAt'].every((key) => typeof value[key] === 'string')
    && typeof value.weight === 'number'
    && Number.isFinite(value.weight)
    && isPlainObject(value.metadata)
    && isPlainObject(value.provenance);
}

function normalizeMode(raw: unknown): ImportMode {
  return raw === 'replaceProject' ? 'replaceProject' : 'upsert';
}

async function currentCounts(): Promise<{ currentNodes: number; currentEdges: number }> {
  const pid = config.projectId;
  const nodeRows = await runRead('MATCH (n:Entity {projectId:$pid}) RETURN count(n) AS c', { pid });
  const edgeRows = await runRead('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN count(r) AS c', { pid });
  return {
    currentNodes: toInt(nodeRows[0]?.get('c') ?? 0),
    currentEdges: toInt(edgeRows[0]?.get('c') ?? 0),
  };
}

export async function closeSnapshotDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

export async function exportGraphSnapshot(): Promise<GraphSnapshot> {
  const pid = config.projectId;
  const [nodeRows, edgeRows] = await Promise.all([
    runRead('MATCH (n:Entity {projectId:$pid}) RETURN n ORDER BY n.type, n.label, n.id', { pid }),
    runRead(
      `MATCH (a:Entity {projectId:$pid})-[rel:REL]->(b:Entity {projectId:$pid})
       RETURN a.id AS fromId, b.id AS toId, rel
       ORDER BY rel.kind, rel.id`,
      { pid },
    ),
  ]);
  const nodes = nodeRows.map((rec) => nodeFrom(rec.get('n')));
  const edges = edgeRows.map((rec) => edgeFrom(rec.get('rel'), String(rec.get('fromId')), String(rec.get('toId'))));
  return {
    schemaVersion: GRAPH_SNAPSHOT_SCHEMA_VERSION,
    projectId: pid,
    exportedAt: new Date().toISOString(),
    appVersion: config.appVersion,
    counts: { nodes: nodes.length, edges: edges.length },
    nodes,
    edges,
  };
}

export async function validateSnapshotImport(input: { snapshot: unknown; mode?: unknown; dryRun?: boolean }): Promise<SnapshotValidationReport> {
  const mode = normalizeMode(input.mode);
  const counts = await currentCounts();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input.snapshot)) {
    return {
      ok: false,
      targetProjectId: config.projectId,
      mode,
      dryRun: Boolean(input.dryRun),
      counts: { nodes: 0, edges: 0, ...counts },
      errors: ['snapshot_must_be_object'],
      warnings,
    };
  }

  const raw = input.snapshot;
  const schemaVersion = typeof raw.schemaVersion === 'string' ? raw.schemaVersion : undefined;
  const sourceProjectId = typeof raw.projectId === 'string' ? raw.projectId : undefined;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];

  if (schemaVersion !== GRAPH_SNAPSHOT_SCHEMA_VERSION) errors.push('unsupported_schema_version');
  if (!sourceProjectId) errors.push('missing_project_id');
  if (sourceProjectId && sourceProjectId !== config.projectId) warnings.push('source_project_id_differs_from_target');
  if (!Array.isArray(raw.nodes)) errors.push('nodes_must_be_array');
  if (!Array.isArray(raw.edges)) errors.push('edges_must_be_array');
  if (nodes.length === 0) warnings.push('snapshot_contains_no_nodes');

  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (!isGraphNode(node)) {
      errors.push(`invalid_node_at_${index}`);
      continue;
    }
    if (!node.id.trim()) errors.push(`node_missing_id_at_${index}`);
    if (!node.type.trim()) errors.push(`node_missing_type_at_${index}`);
    if (!node.label.trim()) errors.push(`node_missing_label_at_${index}`);
    if (nodeIds.has(node.id)) errors.push(`duplicate_node_id:${node.id}`);
    nodeIds.add(node.id);
    for (const workingStateError of validateWorkingDraftSnapshotNode(node)) {
      errors.push(`${workingStateError}_at_${index}`);
    }
  }

  for (const [index, edge] of edges.entries()) {
    if (!isGraphEdge(edge)) {
      errors.push(`invalid_edge_at_${index}`);
      continue;
    }
    if (!edge.id.trim()) errors.push(`edge_missing_id_at_${index}`);
    if (!edge.kind.trim()) errors.push(`edge_missing_kind_at_${index}`);
    if (edgeIds.has(edge.id)) errors.push(`duplicate_edge_id:${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromId)) errors.push(`missing_edge_from_endpoint:${edge.id}:${edge.fromId}`);
    if (!nodeIds.has(edge.toId)) errors.push(`missing_edge_to_endpoint:${edge.id}:${edge.toId}`);
  }

  return {
    ok: errors.length === 0,
    schemaVersion,
    sourceProjectId,
    targetProjectId: config.projectId,
    mode,
    dryRun: Boolean(input.dryRun),
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      currentNodes: counts.currentNodes,
      currentEdges: counts.currentEdges,
    },
    errors,
    warnings,
  };
}

export function snapshotNodeImportRow(node: SnapshotGraphNode, now: string): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    content: node.content ?? '',
    metadataJson: JSON.stringify(node.metadata ?? {}),
    provenanceJson: JSON.stringify(node.provenance ?? {}),
    createdAt: node.createdAt || now,
    updatedAt: node.updatedAt || now,
    // Null deliberately removes stale CAS/history properties in upsert mode.
    workingHistory: node.workingHistory ?? null,
    workingRevision: node.workingRevision == null ? null : neo4j.int(node.workingRevision),
    workingContentHash: node.workingContentHash?.toLowerCase() ?? null,
    workingUpdatedAt: node.workingUpdatedAt ?? null,
    workingUpdatedBy: node.workingUpdatedBy ?? null,
    lastWorkingMutationId: node.lastWorkingMutationId ?? null,
    lastWorkingChangeSummary: node.lastWorkingChangeSummary ?? null,
    workingAuditStatus: node.workingAuditStatus ?? null,
    workingAuditContentHash: node.workingAuditContentHash?.toLowerCase() ?? null,
    workingAuditRevision: node.workingAuditRevision == null ? null : neo4j.int(node.workingAuditRevision),
    workingAuditAt: node.workingAuditAt ?? null,
    workingAuditError: node.workingAuditError ?? null,
  };
}

export async function importGraphSnapshot(input: {
  snapshot: unknown;
  mode?: unknown;
  dryRun?: boolean;
  confirmProjectId?: unknown;
}): Promise<SnapshotImportResult> {
  const mode = normalizeMode(input.mode);
  const report = await validateSnapshotImport({ snapshot: input.snapshot, mode, dryRun: input.dryRun });
  if (!report.ok || input.dryRun) return { ok: report.ok, dryRun: Boolean(input.dryRun), mode, report };

  if (mode === 'replaceProject' && input.confirmProjectId !== config.projectId) {
    return {
      ok: false,
      dryRun: false,
      mode,
      report: {
        ...report,
        ok: false,
        errors: [...report.errors, 'replace_project_requires_confirm_project_id'],
      },
    };
  }

  const snapshot = input.snapshot as GraphSnapshot;
  const now = new Date().toISOString();
  const nodes = snapshot.nodes.map((node) => snapshotNodeImportRow(node, now));
  const edges = snapshot.edges.map((edge) => ({
    ...edge,
    metadataJson: JSON.stringify(edge.metadata ?? {}),
    provenanceJson: JSON.stringify(edge.provenance ?? {}),
    createdAt: edge.createdAt || now,
  }));

  const session = getDriver().session({ defaultAccessMode: neo4j.session.WRITE });
  try {
    await session.executeWrite(async (tx) => {
      if (mode === 'replaceProject') {
        await tx.run('MATCH (n:Entity {projectId:$pid}) DETACH DELETE n', { pid: config.projectId });
      }
      await tx.run(
        `UNWIND $nodes AS row
         MERGE (n:Entity {projectId:$pid, id:row.id})
         SET n.type = row.type,
             n.label = row.label,
             n.content = row.content,
             n.metadata = row.metadataJson,
             n.provenance = row.provenanceJson,
             n.createdAt = row.createdAt,
             n.updatedAt = row.updatedAt,
             n.workingHistory = row.workingHistory,
             n.workingRevision = row.workingRevision,
             n.workingContentHash = row.workingContentHash,
             n.workingUpdatedAt = row.workingUpdatedAt,
             n.workingUpdatedBy = row.workingUpdatedBy,
             n.lastWorkingMutationId = row.lastWorkingMutationId,
             n.lastWorkingChangeSummary = row.lastWorkingChangeSummary,
             n.workingAuditStatus = row.workingAuditStatus,
             n.workingAuditContentHash = row.workingAuditContentHash,
             n.workingAuditRevision = row.workingAuditRevision,
             n.workingAuditAt = row.workingAuditAt,
             n.workingAuditError = row.workingAuditError`,
        { pid: config.projectId, nodes },
      );
      await tx.run(
        `UNWIND $edges AS row
         OPTIONAL MATCH (:Entity {projectId:$pid})-[old:REL {id:row.id}]->(:Entity {projectId:$pid})
         WITH row, collect(old) AS oldRels
         FOREACH (old IN oldRels | DELETE old)
         WITH DISTINCT row
         MATCH (a:Entity {projectId:$pid, id:row.fromId})
         MATCH (b:Entity {projectId:$pid, id:row.toId})
         CREATE (a)-[rel:REL]->(b)
         SET rel.id = row.id,
             rel.kind = row.kind,
             rel.weight = row.weight,
             rel.metadata = row.metadataJson,
             rel.provenance = row.provenanceJson,
             rel.createdAt = row.createdAt`,
        { pid: config.projectId, edges },
      );
    });
  } finally {
    await session.close();
  }

  return {
    ok: true,
    dryRun: false,
    mode,
    report,
    written: { nodes: nodes.length, edges: edges.length },
  };
}
