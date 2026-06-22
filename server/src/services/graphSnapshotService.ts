import neo4j, { Driver, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';
import type { GraphEdge, GraphNode } from './neo4jReadService.js';

export const GRAPH_SNAPSHOT_SCHEMA_VERSION = 'romanzo-gabriele.graph-snapshot.v1';

export interface GraphSnapshot {
  schemaVersion: typeof GRAPH_SNAPSHOT_SCHEMA_VERSION;
  projectId: string;
  exportedAt: string;
  appVersion: string;
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: GraphNode[];
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

function nodeFrom(node: Node): GraphNode {
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

function isGraphNode(value: unknown): value is GraphNode {
  if (!isPlainObject(value)) return false;
  return ['id', 'type', 'label', 'content', 'createdAt', 'updatedAt'].every((key) => typeof value[key] === 'string')
    && isPlainObject(value.metadata)
    && isPlainObject(value.provenance);
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
  const nodes = snapshot.nodes.map((node) => ({
    ...node,
    content: node.content ?? '',
    metadataJson: JSON.stringify(node.metadata ?? {}),
    provenanceJson: JSON.stringify(node.provenance ?? {}),
    createdAt: node.createdAt || now,
    updatedAt: node.updatedAt || now,
  }));
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
             n.updatedAt = row.updatedAt`,
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
