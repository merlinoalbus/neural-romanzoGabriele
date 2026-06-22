import neo4j, { Driver, Node, Record as Neo4jRecord, Relationship } from 'neo4j-driver';
import { config } from '../config.js';

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

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(neo4jUri(), neo4j.auth.basic(config.neo4j.user, config.neo4j.password), {
      maxConnectionPoolSize: 10,
    });
  }
  return driver;
}

function neo4jUri(): string {
  return config.neo4j.uri;
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

async function run(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
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

function luceneQuery(query: string): string {
  const esc = (s: string): string => s.replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1');
  return query.split(/\s+/).map((token) => token.trim()).filter(Boolean).map(esc).join(' OR ');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function isMissingIndexError(err: unknown): boolean {
  return /entity_fts|fulltext|NoSuchIndex|no such (index|fulltext)/i.test(String(err));
}

export async function pingNeo4j(): Promise<boolean> {
  const records = await run('RETURN 1 AS ok');
  return records.length > 0;
}

export async function stats(): Promise<{ nodes: number; edges: number; nodeTypes: Record<string, number>; edgeKinds: Record<string, number> }> {
  const pid = config.projectId;
  const nodes = toInt((await run('MATCH (n:Entity {projectId:$pid}) RETURN count(n) AS c', { pid }))[0]?.get('c') ?? 0);
  const edges = toInt((await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN count(r) AS c', { pid }))[0]?.get('c') ?? 0);
  const nodeTypes: Record<string, number> = {};
  for (const rec of await run('MATCH (n:Entity {projectId:$pid}) RETURN n.type AS k, count(*) AS c ORDER BY c DESC', { pid })) {
    nodeTypes[String(rec.get('k'))] = toInt(rec.get('c'));
  }
  const edgeKinds: Record<string, number> = {};
  for (const rec of await run('MATCH (:Entity {projectId:$pid})-[r:REL]->(:Entity {projectId:$pid}) RETURN r.kind AS k, count(*) AS c ORDER BY c DESC', { pid })) {
    edgeKinds[String(rec.get('k'))] = toInt(rec.get('c'));
  }
  return { nodes, edges, nodeTypes, edgeKinds };
}

export async function search(query: string, opts: { type?: string; limit?: number } = {}): Promise<GraphNode[]> {
  const pid = config.projectId;
  const q = luceneQuery(query);
  if (!q) return [];
  const limit = clampInt(opts.limit, 25, 1, 200);
  try {
    const records = await run(
      `CALL db.index.fulltext.queryNodes('entity_fts', $q) YIELD node, score
       WHERE node.projectId = $pid ${opts.type ? 'AND node.type = $type' : ''}
       RETURN node ORDER BY score DESC LIMIT $limit`,
      { q, pid, type: opts.type ?? null, limit: neo4j.int(limit) },
    );
    return records.map((rec) => nodeFrom(rec.get('node')));
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    const needle = query.trim();
    const records = await run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE (n.label CONTAINS $needle OR n.content CONTAINS $needle) ${opts.type ? 'AND n.type = $type' : ''}
       RETURN n LIMIT $limit`,
      { pid, needle, type: opts.type ?? null, limit: neo4j.int(limit) },
    );
    return records.map((rec) => nodeFrom(rec.get('n')));
  }
}

export async function getNodeById(id: string): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {id:$id, projectId:$pid}) RETURN n', { id, pid: config.projectId });
  return records.length ? nodeFrom(records[0].get('n')) : null;
}

export async function getNodeByTypeLabel(type: string, label: string): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {projectId:$pid, type:$type, label:$label}) RETURN n LIMIT 1', {
    pid: config.projectId,
    type,
    label,
  });
  return records.length ? nodeFrom(records[0].get('n')) : null;
}

export async function neighbors(nodeId: string, opts: { depth?: number; kinds?: string[] } = {}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const pid = config.projectId;
  const depth = clampInt(opts.depth, 1, 1, 5);
  const kinds = opts.kinds ?? [];
  const nodeRows = await run(
    `MATCH (s:Entity {id:$id, projectId:$pid})
     OPTIONAL MATCH (s)-[:REL*1..${depth}]-(m:Entity {projectId:$pid})
     WITH s, collect(DISTINCT m.id) AS mids
     RETURN [s.id] + mids AS ids`,
    { id: nodeId, pid },
  );
  const ids = (nodeRows.length ? (nodeRows[0].get('ids') as string[]) : []).filter(Boolean);
  if (!ids.length) return { nodes: [], edges: [] };
  const nodes = await run('MATCH (n:Entity {projectId:$pid}) WHERE n.id IN $ids RETURN n', { ids, pid });
  const edges = await run(
    `MATCH (a:Entity {projectId:$pid})-[rel:REL]->(b:Entity {projectId:$pid})
     WHERE a.id IN $ids AND b.id IN $ids AND (size($kinds) = 0 OR rel.kind IN $kinds)
     RETURN a.id AS fromId, b.id AS toId, rel`,
    { ids, pid, kinds },
  );
  return {
    nodes: nodes.map((rec) => nodeFrom(rec.get('n'))),
    edges: edges.map((rec) => edgeFrom(rec.get('rel'), String(rec.get('fromId')), String(rec.get('toId')))),
  };
}

export async function listDocuments(opts: { sourceType?: string; limit?: number } = {}): Promise<GraphNode[]> {
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run("MATCH (n:Entity {projectId:$pid, type:'document'}) RETURN n ORDER BY n.updatedAt DESC LIMIT $limit", {
    pid: config.projectId,
    limit: neo4j.int(limit),
  });
  const docs = records.map((rec) => nodeFrom(rec.get('n')));
  return opts.sourceType ? docs.filter((doc) => doc.metadata.sourceType === opts.sourceType) : docs;
}
