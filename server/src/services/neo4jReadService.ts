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

export interface OpenPoint {
  finding: GraphNode;
  plotThread: GraphNode | null;
}

const NARRATIVE_HIDDEN_NODE_TYPES = [
  'bible_candidate',
  'bible_coverage_finding',
  'bible_mapping_batch',
  'bible_outline',
  'bible_section',
];
const OPEN_POINT_FINDING_TYPE = 'continuity_finding';
const OPEN_POINT_LABEL_PREFIX = 'plot_thread_inactive:';

interface NarrativeViewOpts {
  includeInternal?: boolean;
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

function viewParams(opts: NarrativeViewOpts = {}): { includeInternal: boolean; hiddenTypes: string[]; openPointLabelPrefix: string } {
  return {
    includeInternal: opts.includeInternal === true,
    hiddenTypes: NARRATIVE_HIDDEN_NODE_TYPES,
    openPointLabelPrefix: OPEN_POINT_LABEL_PREFIX,
  };
}

function isOpenPointFinding(node: GraphNode): boolean {
  return node.type === OPEN_POINT_FINDING_TYPE && node.label.startsWith(OPEN_POINT_LABEL_PREFIX);
}

function isNarrativeVisible(node: GraphNode, opts: NarrativeViewOpts = {}): boolean {
  return opts.includeInternal === true || (!NARRATIVE_HIDDEN_NODE_TYPES.includes(node.type) && !isOpenPointFinding(node));
}

export async function pingNeo4j(): Promise<boolean> {
  const records = await run('RETURN 1 AS ok');
  return records.length > 0;
}

export async function stats(opts: NarrativeViewOpts = {}): Promise<{ nodes: number; edges: number; nodeTypes: Record<string, number>; edgeKinds: Record<string, number> }> {
  const pid = config.projectId;
  const params = { pid, ...viewParams(opts) };
  // Four independent aggregations: run them concurrently on the driver's connection pool.
  const [nodeCountRecs, edgeCountRecs, nodeTypeRecs, edgeKindRecs] = await Promise.all([
    run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE $includeInternal OR (NOT (n.type IN $hiddenTypes) AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix))
       RETURN count(n) AS c`,
      params,
    ),
    run(
      `MATCH (a:Entity {projectId:$pid})-[r:REL]->(b:Entity {projectId:$pid})
       WHERE $includeInternal OR (
         NOT (a.type IN $hiddenTypes)
         AND NOT (b.type IN $hiddenTypes)
         AND NOT (a.type = 'continuity_finding' AND a.label STARTS WITH $openPointLabelPrefix)
         AND NOT (b.type = 'continuity_finding' AND b.label STARTS WITH $openPointLabelPrefix)
       )
       RETURN count(r) AS c`,
      params,
    ),
    run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE $includeInternal OR (NOT (n.type IN $hiddenTypes) AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix))
       RETURN n.type AS k, count(*) AS c ORDER BY c DESC`,
      params,
    ),
    run(
      `MATCH (a:Entity {projectId:$pid})-[r:REL]->(b:Entity {projectId:$pid})
       WHERE $includeInternal OR (
         NOT (a.type IN $hiddenTypes)
         AND NOT (b.type IN $hiddenTypes)
         AND NOT (a.type = 'continuity_finding' AND a.label STARTS WITH $openPointLabelPrefix)
         AND NOT (b.type = 'continuity_finding' AND b.label STARTS WITH $openPointLabelPrefix)
       )
       RETURN r.kind AS k, count(*) AS c ORDER BY c DESC`,
      params,
    ),
  ]);
  const nodes = toInt(nodeCountRecs[0]?.get('c') ?? 0);
  const edges = toInt(edgeCountRecs[0]?.get('c') ?? 0);
  const nodeTypes: Record<string, number> = {};
  for (const rec of nodeTypeRecs) {
    nodeTypes[String(rec.get('k'))] = toInt(rec.get('c'));
  }
  const edgeKinds: Record<string, number> = {};
  for (const rec of edgeKindRecs) {
    edgeKinds[String(rec.get('k'))] = toInt(rec.get('c'));
  }
  return { nodes, edges, nodeTypes, edgeKinds };
}

export async function search(query: string, opts: { type?: string; limit?: number; includeInternal?: boolean } = {}): Promise<GraphNode[]> {
  const pid = config.projectId;
  const q = luceneQuery(query);
  if (!q) return [];
  const limit = clampInt(opts.limit, 25, 1, 200);
  const params = { q, pid, type: opts.type ?? null, limit: neo4j.int(limit), ...viewParams(opts) };
  try {
    const records = await run(
      `CALL db.index.fulltext.queryNodes('entity_fts', $q) YIELD node, score
       WHERE node.projectId = $pid
         AND ($includeInternal OR (NOT (node.type IN $hiddenTypes) AND NOT (node.type = 'continuity_finding' AND node.label STARTS WITH $openPointLabelPrefix)))
         ${opts.type ? 'AND node.type = $type' : ''}
       RETURN node ORDER BY score DESC LIMIT $limit`,
      params,
    );
    return records.map((rec) => nodeFrom(rec.get('node')));
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    const needle = query.trim();
    const records = await run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE (n.label CONTAINS $needle OR n.content CONTAINS $needle)
         AND ($includeInternal OR (NOT (n.type IN $hiddenTypes) AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix)))
         ${opts.type ? 'AND n.type = $type' : ''}
       RETURN n LIMIT $limit`,
      { ...params, needle },
    );
    return records.map((rec) => nodeFrom(rec.get('n')));
  }
}

export async function getNodeById(id: string, opts: NarrativeViewOpts = {}): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {id:$id, projectId:$pid}) RETURN n', { id, pid: config.projectId });
  if (!records.length) return null;
  const node = nodeFrom(records[0].get('n'));
  return isNarrativeVisible(node, opts) ? node : null;
}

export async function getNodeByTypeLabel(type: string, label: string, opts: NarrativeViewOpts = {}): Promise<GraphNode | null> {
  const records = await run('MATCH (n:Entity {projectId:$pid, type:$type, label:$label}) RETURN n LIMIT 1', {
    pid: config.projectId,
    type,
    label,
  });
  if (!records.length) return null;
  const node = nodeFrom(records[0].get('n'));
  return isNarrativeVisible(node, opts) ? node : null;
}

export async function neighbors(nodeId: string, opts: { depth?: number; kinds?: string[]; includeInternal?: boolean } = {}): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const pid = config.projectId;
  const depth = clampInt(opts.depth, 1, 1, 5);
  const kinds = opts.kinds ?? [];
  const params = { id: nodeId, pid, ...viewParams(opts) };
  const nodeRows = await run(
    `MATCH (s:Entity {id:$id, projectId:$pid})
     WHERE $includeInternal OR (NOT (s.type IN $hiddenTypes) AND NOT (s.type = 'continuity_finding' AND s.label STARTS WITH $openPointLabelPrefix))
     OPTIONAL MATCH p=(s)-[:REL*1..${depth}]-(m:Entity {projectId:$pid})
     WHERE $includeInternal OR all(pathNode IN nodes(p) WHERE NOT (pathNode.type IN $hiddenTypes) AND NOT (pathNode.type = 'continuity_finding' AND pathNode.label STARTS WITH $openPointLabelPrefix))
     WITH s, collect(DISTINCT m.id) AS mids
     RETURN [s.id] + mids AS ids`,
    params,
  );
  const ids = (nodeRows.length ? (nodeRows[0].get('ids') as string[]) : []).filter(Boolean);
  if (!ids.length) return { nodes: [], edges: [] };
  const nodes = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE n.id IN $ids
       AND ($includeInternal OR (NOT (n.type IN $hiddenTypes) AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix)))
     RETURN n`,
    {
      ids,
      pid,
      ...viewParams(opts),
    },
  );
  const visibleIds = nodes.map((rec) => String((rec.get('n') as Node).properties.id));
  const edges = await run(
    `MATCH (a:Entity {projectId:$pid})-[rel:REL]->(b:Entity {projectId:$pid})
     WHERE a.id IN $ids AND b.id IN $ids AND (size($kinds) = 0 OR rel.kind IN $kinds)
     RETURN a.id AS fromId, b.id AS toId, rel`,
    { ids: visibleIds, pid, kinds },
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

export async function listNodes(opts: { type?: string; limit?: number; includeInternal?: boolean } = {}): Promise<GraphNode[]> {
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run(
    `MATCH (n:Entity {projectId:$pid})
     WHERE ($type IS NULL OR n.type = $type)
       AND ($includeInternal OR (NOT (n.type IN $hiddenTypes) AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix)))
     RETURN n
     ORDER BY n.updatedAt DESC, n.type, n.label
     LIMIT $limit`,
    { pid: config.projectId, type: opts.type ?? null, limit: neo4j.int(limit), ...viewParams(opts) },
  );
  return records.map((rec) => nodeFrom(rec.get('n')));
}

export interface ChapterSummary {
  id: string;
  label: string;
  number: number | null;
  title: string;
  date: string | null;
  timePlane: string | null;
  chapterKind: string | null;
  documentChapterLabel: string | null;
  primarySectionKey: string | null;
  frameOrder: number | null;
  role?: 'prologo' | 'epilogo';
}

export interface DuplicateChapterIdentity {
  chapterNumber: number;
  nodeIds: string[];
}

export class ChapterListIntegrityError extends Error {
  readonly code = 'CHAPTER_IDENTITY_AMBIGUOUS';
  readonly duplicates: DuplicateChapterIdentity[];

  constructor(duplicates: DuplicateChapterIdentity[]) {
    const ordered = duplicates
      .map((duplicate) => ({ ...duplicate, nodeIds: [...duplicate.nodeIds].sort() }))
      .sort((a, b) => a.chapterNumber - b.chapterNumber);
    super(`chapter_identity_ambiguous: ${ordered.map((item) => `chapterNumber=${item.chapterNumber}, nodeIds=${item.nodeIds.join(',')}`).join('; ')}`);
    this.name = 'ChapterListIntegrityError';
    this.duplicates = ordered;
  }
}

export function assertUniqueNumberedChapters(chapters: ChapterSummary[]): void {
  const byNumber = new Map<number, string[]>();
  for (const chapter of chapters) {
    if (chapter.number === null) continue;
    const ids = byNumber.get(chapter.number) ?? [];
    ids.push(chapter.id);
    byNumber.set(chapter.number, ids);
  }
  const duplicates = [...byNumber.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([chapterNumber, nodeIds]) => ({ chapterNumber, nodeIds }));
  if (duplicates.length) throw new ChapterListIntegrityError(duplicates);
}

function chapterSummaryFrom(node: GraphNode): ChapterSummary {
  const m = node.metadata;
  const rawNumber = m.chapterNumber;
  const number = typeof rawNumber === 'number' ? rawNumber : rawNumber != null && Number.isFinite(Number(rawNumber)) ? Number(rawNumber) : null;
  return {
    id: node.id,
    label: node.label,
    number,
    title: String(m.chapterTitle ?? node.label),
    date: m.date ? String(m.date) : null,
    timePlane: m.timePlane ? String(m.timePlane) : null,
    chapterKind: m.chapterKind ? String(m.chapterKind) : null,
    documentChapterLabel: m.documentChapterLabel ? String(m.documentChapterLabel) : null,
    primarySectionKey: m.primarySectionKey ? String(m.primarySectionKey) : null,
    frameOrder: typeof m.frameOrder === 'number' ? m.frameOrder : m.frameOrder != null && Number.isFinite(Number(m.frameOrder)) ? Number(m.frameOrder) : null,
  };
}

function bookendFrom(node: GraphNode, role: 'prologo' | 'epilogo'): ChapterSummary {
  const summary = chapterSummaryFrom(node);
  return { ...summary, number: null, timePlane: summary.timePlane ?? 'frame', chapterKind: summary.chapterKind ?? 'interlude', role };
}

// The narrative runs Prologo → Cap 1 … Cap 40 → Epilogo. Prologo/Epilogo are frame
// timeline_events (2080 cornice), not `chapter` nodes, so they are recovered as the
// non-chapter bookends of the `precedes` chain and placed before/after the chapters.
export async function listChapters(): Promise<ChapterSummary[]> {
  const pid = config.projectId;
  const [records, prologoRecs, epilogoRecs] = await Promise.all([
    run("MATCH (n:Entity {projectId:$pid, type:'chapter'}) RETURN n", { pid }),
    run(
      `MATCH (p:Entity {projectId:$pid})-[:REL {kind:'precedes'}]->(c:Entity {projectId:$pid, type:'chapter'})
       WHERE p.type <> 'chapter' AND toLower(p.label) STARTS WITH 'prologo'
       RETURN p LIMIT 1`,
      { pid },
    ),
    run(
      `MATCH (c:Entity {projectId:$pid, type:'chapter'})-[:REL {kind:'precedes'}]->(e:Entity {projectId:$pid})
       WHERE e.type <> 'chapter' AND toLower(e.label) STARTS WITH 'epilogo'
       RETURN e LIMIT 1`,
      { pid },
    ),
  ]);
  const chapters = records.map((rec) => chapterSummaryFrom(nodeFrom(rec.get('n'))));
  assertUniqueNumberedChapters(chapters);
  chapters.sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
  const result: ChapterSummary[] = [];
  if (prologoRecs.length) result.push(bookendFrom(nodeFrom(prologoRecs[0].get('p')), 'prologo'));
  result.push(...chapters);
  if (epilogoRecs.length) result.push(bookendFrom(nodeFrom(epilogoRecs[0].get('e')), 'epilogo'));
  return result;
}

export interface ChapterRelation {
  node: GraphNode;
  kind: string;
  direction: 'out' | 'in';
}

export interface ChapterMention {
  fromId: string;
  fromLabel: string;
  fromType: string;
  fromSection: string | null;
  refType: string | null;
  originalCitation: string | null;
}

export interface ChapterPacket {
  chapter: GraphNode | null;
  prev: ChapterSummary[];
  next: ChapterSummary[];
  touches: ChapterRelation[];
  incomingMentions: ChapterMention[];
}

export async function chapterPacket(id: string): Promise<ChapterPacket> {
  const pid = config.projectId;
  const chapter = await getNodeById(id, { includeInternal: true });
  // Prologo/Epilogo are frame `timeline_event` bookends (not `chapter` nodes) but are
  // navigated from the Capitolo/Romanzo views; accept them so their detail renders.
  const isBookend = !!chapter && chapter.type !== 'chapter' && /^(prologo|epilogo)/i.test(chapter.label);
  if (!chapter || (chapter.type !== 'chapter' && !isBookend)) {
    return { chapter: null, prev: [], next: [], touches: [], incomingMentions: [] };
  }
  const [prevRecs, nextRecs, touchRecs, mentionRecs] = await Promise.all([
    run(
      "MATCH (p:Entity {projectId:$pid, type:'chapter'})-[:REL {kind:'precedes'}]->(c:Entity {id:$id, projectId:$pid}) RETURN p",
      { pid, id },
    ),
    run(
      "MATCH (c:Entity {id:$id, projectId:$pid})-[:REL {kind:'precedes'}]->(n:Entity {projectId:$pid, type:'chapter'}) RETURN n",
      { pid, id },
    ),
    run(
      `MATCH (c:Entity {id:$id, projectId:$pid})-[r:REL]-(m:Entity {projectId:$pid})
       WHERE r.kind <> 'precedes' AND r.kind <> 'mentions'
         AND NOT (m.type IN $hiddenTypes)
         AND NOT (m.type = 'continuity_finding' AND m.label STARTS WITH $openPointLabelPrefix)
       RETURN DISTINCT m, r.kind AS kind, (startNode(r).id = $id) AS outgoing`,
      { pid, id, hiddenTypes: NARRATIVE_HIDDEN_NODE_TYPES, openPointLabelPrefix: OPEN_POINT_LABEL_PREFIX },
    ),
    run(
      `MATCH (s:Entity {projectId:$pid})-[r:REL {kind:'mentions'}]->(c:Entity {id:$id, projectId:$pid}) RETURN s, r`,
      { pid, id },
    ),
  ]);
  const prev = prevRecs.map((rec) => chapterSummaryFrom(nodeFrom(rec.get('p')))).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const next = nextRecs.map((rec) => chapterSummaryFrom(nodeFrom(rec.get('n')))).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const touches: ChapterRelation[] = touchRecs.map((rec) => ({
    node: nodeFrom(rec.get('m')),
    kind: String(rec.get('kind')),
    direction: rec.get('outgoing') === true ? 'out' : 'in',
  }));
  const incomingMentions: ChapterMention[] = mentionRecs.map((rec) => {
    const source = nodeFrom(rec.get('s'));
    const meta = edgeFrom(rec.get('r'), source.id, id).metadata;
    return {
      fromId: source.id,
      fromLabel: source.label,
      fromType: source.type,
      fromSection: meta.fromSection ? String(meta.fromSection) : null,
      refType: meta.refType ? String(meta.refType) : null,
      originalCitation: meta.originalCitation ? String(meta.originalCitation) : null,
    };
  });
  return { chapter, prev, next, touches, incomingMentions };
}

export interface EntityPacket {
  node: GraphNode | null;
  touches: ChapterRelation[];
  incomingMentions: ChapterMention[];
}

// Generic node "packet" reusable across character / plot_thread / any node type:
// the node itself, all non-`mentions` edges grouped later on the client by kind+direction,
// and the incoming `mentions` cross-references. Mirrors chapterPacket without the
// chapter-specific prev/next adjacency.
export async function entityPacket(id: string): Promise<EntityPacket> {
  const pid = config.projectId;
  const node = await getNodeById(id, { includeInternal: true });
  if (!node) return { node: null, touches: [], incomingMentions: [] };
  const [touchRecs, mentionRecs] = await Promise.all([
    run(
      `MATCH (c:Entity {id:$id, projectId:$pid})-[r:REL]-(m:Entity {projectId:$pid})
       WHERE r.kind <> 'mentions'
         AND NOT (m.type IN $hiddenTypes)
         AND NOT (m.type = 'continuity_finding' AND m.label STARTS WITH $openPointLabelPrefix)
       RETURN DISTINCT m, r.kind AS kind, (startNode(r).id = $id) AS outgoing`,
      { pid, id, hiddenTypes: NARRATIVE_HIDDEN_NODE_TYPES, openPointLabelPrefix: OPEN_POINT_LABEL_PREFIX },
    ),
    run(
      `MATCH (s:Entity {projectId:$pid})-[r:REL {kind:'mentions'}]->(c:Entity {id:$id, projectId:$pid}) RETURN s, r`,
      { pid, id },
    ),
  ]);
  const touches: ChapterRelation[] = touchRecs.map((rec) => ({
    node: nodeFrom(rec.get('m')),
    kind: String(rec.get('kind')),
    direction: (rec.get('outgoing') === true ? 'out' : 'in') as 'out' | 'in',
  }));
  const incomingMentions: ChapterMention[] = mentionRecs.map((rec) => {
    const source = nodeFrom(rec.get('s'));
    const meta = edgeFrom(rec.get('r'), source.id, id).metadata;
    return {
      fromId: source.id,
      fromLabel: source.label,
      fromType: source.type,
      fromSection: meta.fromSection ? String(meta.fromSection) : null,
      refType: meta.refType ? String(meta.refType) : null,
      originalCitation: meta.originalCitation ? String(meta.originalCitation) : null,
    };
  });
  return { node, touches, incomingMentions };
}

export interface TimelineEntry {
  id: string;
  label: string;
  content: string;
  chapterId: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  date: string | null;
  timePlane: string | null;
}

// timeline_event nodes carry no standardized date/plane fields; ordering and dating are
// derived from the linked chapter (via `part_of`/`occurs_in`), with the event's own
// metadata.date/dateStart as a fallback. Events with no chapter anchor sort to the end.
export async function timeline(): Promise<TimelineEntry[]> {
  const pid = config.projectId;
  const records = await run(
    `MATCH (e:Entity {projectId:$pid, type:'timeline_event'})
     OPTIONAL MATCH (e)-[r:REL]->(c:Entity {projectId:$pid, type:'chapter'})
       WHERE r.kind IN ['part_of','occurs_in']
     WITH e, collect(c)[0] AS chapter
     RETURN e, chapter`,
    { pid },
  );
  const entries: TimelineEntry[] = records.map((rec) => {
    const event = nodeFrom(rec.get('e'));
    const chapterRaw = rec.get('chapter');
    const chapter = chapterRaw ? nodeFrom(chapterRaw) : null;
    const cm = chapter?.metadata ?? {};
    const em = event.metadata;
    const rawNumber = cm.chapterNumber;
    const chapterNumber = typeof rawNumber === 'number' ? rawNumber : rawNumber != null && Number.isFinite(Number(rawNumber)) ? Number(rawNumber) : null;
    const eventDate = em.date ?? em.dateStart;
    return {
      id: event.id,
      label: event.label,
      content: event.content,
      chapterId: chapter?.id ?? null,
      chapterNumber,
      chapterTitle: chapter ? String(cm.chapterTitle ?? chapter.label) : null,
      date: eventDate != null ? String(eventDate) : cm.date != null ? String(cm.date) : null,
      timePlane: cm.timePlane != null ? String(cm.timePlane) : em.timePlane != null ? String(em.timePlane) : null,
    };
  });
  entries.sort((a, b) => {
    const an = a.chapterNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.chapterNumber ?? Number.MAX_SAFE_INTEGER;
    return an !== bn ? an - bn : a.label.localeCompare(b.label);
  });
  return entries;
}

export interface HealthReport {
  totals: { nodes: number; edges: number };
  nodeTypes: Record<string, number>;
  edgeKinds: Record<string, number>;
  relatedToEdges: number;
  orphanNodes: number;
  chaptersMissingDate: number;
  timelineUnanchored: number;
  openPoints: number;
}

// Graph-derived model health (the audit findings themselves live only in committed
// report files by design — "il grafo contiene solo il modello consolidato"). This
// surfaces live structural signals: generic-edge debt, orphans, missing chapter dates,
// unanchored timeline events, and open plot-thread points.
export async function health(): Promise<HealthReport> {
  const pid = config.projectId;
  const [base, relatedRows, orphanRows, chapters, tl, openPoints] = await Promise.all([
    stats(),
    run(
      "MATCH (:Entity {projectId:$pid})-[r:REL {kind:'related_to'}]->(:Entity {projectId:$pid}) RETURN count(r) AS c",
      { pid },
    ),
    run(
      `MATCH (n:Entity {projectId:$pid})
       WHERE NOT (n.type IN $hiddenTypes)
         AND NOT (n.type = 'continuity_finding' AND n.label STARTS WITH $openPointLabelPrefix)
         AND NOT (n)-[:REL]-(:Entity {projectId:$pid})
       RETURN count(n) AS c`,
      { pid, hiddenTypes: NARRATIVE_HIDDEN_NODE_TYPES, openPointLabelPrefix: OPEN_POINT_LABEL_PREFIX },
    ),
    listChapters(),
    timeline(),
    listOpenPoints({ limit: 500 }),
  ]);
  return {
    totals: { nodes: base.nodes, edges: base.edges },
    nodeTypes: base.nodeTypes,
    edgeKinds: base.edgeKinds,
    relatedToEdges: toInt(relatedRows[0]?.get('c') ?? 0),
    orphanNodes: toInt(orphanRows[0]?.get('c') ?? 0),
    chaptersMissingDate: chapters.filter((chapter) => !chapter.date && chapter.timePlane !== 'frame').length,
    timelineUnanchored: tl.filter((entry) => !entry.chapterId).length,
    openPoints: openPoints.length,
  };
}

export async function listOpenPoints(opts: { limit?: number } = {}): Promise<OpenPoint[]> {
  const limit = clampInt(opts.limit, 100, 1, 500);
  const records = await run(
    `MATCH (finding:Entity {projectId:$pid, type:'continuity_finding'})
     WHERE finding.label STARTS WITH $openPointLabelPrefix
     OPTIONAL MATCH (finding)-[:REL {kind:'applies_to'}]->(linkedThread:Entity {projectId:$pid, type:'plot_thread'})
     WITH finding, linkedThread
     OPTIONAL MATCH (metadataThread:Entity {projectId:$pid, type:'plot_thread'})
     WHERE linkedThread IS NULL AND finding.metadata CONTAINS metadataThread.id
     WITH finding, linkedThread, collect(metadataThread) AS metadataThreads
     WITH finding, coalesce(linkedThread, head([thread IN metadataThreads WHERE thread IS NOT NULL])) AS plotThread
     RETURN finding, plotThread
     ORDER BY finding.updatedAt DESC, finding.label
     LIMIT $limit`,
    { pid: config.projectId, openPointLabelPrefix: OPEN_POINT_LABEL_PREFIX, limit: neo4j.int(limit) },
  );
  return records.map((rec) => ({
    finding: nodeFrom(rec.get('finding')),
    plotThread: rec.get('plotThread') ? nodeFrom(rec.get('plotThread')) : null,
  }));
}
