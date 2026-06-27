import crypto from 'node:crypto';
import { config } from '../config.js';
import { runQuery as runQueryRaw, type GraphNode } from '../graph/neo4jStore.js';

export interface ConsolidationReport {
  ok: boolean;
  mergedNodes: {
    target: { id: string; type: string; label: string };
    merged: { id: string; type: string; label: string };
  }[];
  inferredEdges: {
    from: { id: string; type: string; label: string };
    to: { id: string; type: string; label: string };
    kind: string;
    reason: string;
  }[];
  stats: {
    nodesBefore: number;
    nodesAfter: number;
    edgesBefore: number;
    edgesAfter: number;
  };
}

interface NodeWithCreatedAt extends GraphNode {
  createdAt: string;
}

interface InferredEdge {
  from: { id: string; type: string; label: string };
  to: { id: string; type: string; label: string };
  kind: string;
  reason: string;
  weight: number;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

type QueryRunner = typeof runQueryRaw;

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeMetadata(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key];
    if (current === undefined) {
      merged[key] = value;
    } else if (Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...new Set([...current, ...value])];
    } else if (
      current &&
      value &&
      typeof current === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(current) &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeMetadata(current as Record<string, unknown>, value as Record<string, unknown>);
    }
  }
  return merged;
}

function toInt(value: unknown): number {
  if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as { toNumber(): number }).toNumber === 'function') {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value);
}

function safeJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function compactEdge(edge: InferredEdge): ConsolidationReport['inferredEdges'][number] {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    reason: edge.reason,
  };
}

function pushUniqueMerge(
  mergePlans: Array<{ target: GraphNode; duplicate: GraphNode }>,
  mergedNodes: ConsolidationReport['mergedNodes'],
  target: GraphNode,
  duplicate: GraphNode,
): void {
  if (target.id === duplicate.id) return;
  if (mergePlans.some((plan) => plan.duplicate.id === duplicate.id)) return;
  mergePlans.push({ target, duplicate });
  mergedNodes.push({
    target: { id: target.id, type: target.type, label: target.label },
    merged: { id: duplicate.id, type: duplicate.type, label: duplicate.label },
  });
}

function addInferredEdge(store: Map<string, InferredEdge>, edge: InferredEdge): void {
  if (edge.from.id === edge.to.id) return;
  const key = inferredEdgeKey(edge);
  if (!store.has(key)) store.set(key, edge);
}

function inferredEdgeKey(edge: Pick<InferredEdge, 'from' | 'to' | 'kind'>): string {
  return `${String(edge.from.id).trim()}->${String(edge.to.id).trim()}:${String(edge.kind).trim()}`;
}

function normalizeInferredEdge(edge: InferredEdge): InferredEdge {
  return {
    ...edge,
    from: { ...edge.from, id: String(edge.from.id).trim() },
    to: { ...edge.to, id: String(edge.to.id).trim() },
    kind: String(edge.kind).trim(),
  };
}

function uniqueInferredEdges(edges: Iterable<InferredEdge>): InferredEdge[] {
  const unique = new Map<string, InferredEdge>();
  for (const edge of edges) {
    if (edge.from.id === edge.to.id) continue;
    const normalized = normalizeInferredEdge(edge);
    const key = inferredEdgeKey(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()];
}

async function writeInferredEdge(runQuery: QueryRunner, projectId: string, edge: InferredEdge): Promise<void> {
  await runQuery(
    `MATCH (from:Entity {id: $fromId, projectId: $projectId}), (to:Entity {id: $toId, projectId: $projectId})
     MERGE (from)-[r:REL {kind: $kind}]->(to)
     ON CREATE SET r.id = $id,
                   r.weight = $weight,
                   r.metadata = $metadata,
                   r.provenance = $provenance,
                   r.createdAt = $createdAt
     ON MATCH SET r.weight = CASE WHEN coalesce(r.weight, 0) < $weight THEN $weight ELSE r.weight END`,
    {
      projectId,
      fromId: edge.from.id,
      toId: edge.to.id,
      kind: edge.kind,
      id: crypto.randomUUID(),
      weight: edge.weight,
      metadata: JSON.stringify(edge.metadata),
      provenance: JSON.stringify(edge.provenance),
      createdAt: new Date().toISOString(),
    },
  );
}

export async function runConsolidation(runQuery = runQueryRaw): Promise<ConsolidationReport> {
  const projectId = config.projectId;
  const initialNodesRes = await runQuery('MATCH (n:Entity {projectId: $projectId}) RETURN count(n) as count', { projectId });
  const initialEdgesRes = await runQuery(
    'MATCH (:Entity {projectId: $projectId})-[r:REL]->(:Entity {projectId: $projectId}) RETURN count(r) as count',
    { projectId },
  );
  const nodesBefore = toInt(initialNodesRes[0]?.get('count') ?? 0);
  const edgesBefore = toInt(initialEdgesRes[0]?.get('count') ?? 0);

  const allNodesRes = await runQuery(
    `MATCH (n:Entity {projectId: $projectId})
     RETURN n.id as id, n.type as type, n.label as label, n.content as content,
            n.metadata as metadata, n.provenance as provenance, n.createdAt as createdAt`,
    { projectId },
  );

  const nodes: NodeWithCreatedAt[] = allNodesRes.map((record) => ({
    id: String(record.get('id')),
    type: String(record.get('type')),
    label: String(record.get('label')),
    content: String(record.get('content') ?? ''),
    metadata: safeJsonRecord(record.get('metadata')),
    provenance: safeJsonRecord(record.get('provenance')),
    createdAt: String(record.get('createdAt') ?? ''),
    updatedAt: String(record.get('createdAt') ?? ''),
  }));

  const mergedNodes: ConsolidationReport['mergedNodes'] = [];
  const mergePlans: Array<{ target: GraphNode; duplicate: GraphNode }> = [];
  const inferredEdges = new Map<string, InferredEdge>();

  for (const node of nodes) {
    const duplicateOf = node.metadata.duplicateOf ?? node.metadata.mergedInto;
    if (typeof duplicateOf !== 'string' || !duplicateOf.trim()) continue;
    const target = nodes.find((candidate) => candidate.id === duplicateOf);
    if (target) pushUniqueMerge(mergePlans, mergedNodes, target, node);
  }

  const alreadyMergedIds = new Set(mergePlans.map((plan) => plan.duplicate.id));
  const groups = new Map<string, NodeWithCreatedAt[]>();
  for (const node of nodes) {
    if (alreadyMergedIds.has(node.id)) continue;
    const key = `${node.type}:${normalizeLabel(node.label)}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const target = group[0];
    for (const duplicate of group.slice(1)) pushUniqueMerge(mergePlans, mergedNodes, target, duplicate);
  }

  for (const { target, duplicate } of mergePlans) {
    const content = target.content || duplicate.content;
    const metadata = mergeMetadata(target.metadata, duplicate.metadata);
    const provenance = mergeMetadata(target.provenance, duplicate.provenance);

    await runQuery(
      `MATCH (t:Entity {id: $targetId, projectId: $projectId})
       SET t.content = $content, t.metadata = $metadata, t.provenance = $provenance, t.updatedAt = $updatedAt`,
      {
        projectId,
        targetId: target.id,
        content,
        metadata: JSON.stringify(metadata),
        provenance: JSON.stringify(provenance),
        updatedAt: new Date().toISOString(),
      },
    );

    await runQuery(
      `MATCH (d:Entity {id: $duplicateId, projectId: $projectId})-[r:REL]->(other:Entity {projectId: $projectId})
       MATCH (t:Entity {id: $targetId, projectId: $projectId})
       MERGE (t)-[newR:REL {kind: r.kind}]->(other)
       ON CREATE SET newR.id = $id,
                     newR.weight = r.weight,
                     newR.metadata = r.metadata,
                     newR.provenance = r.provenance,
                     newR.createdAt = r.createdAt
       ON MATCH SET newR.weight = CASE WHEN coalesce(newR.weight, 0) < coalesce(r.weight, 1) THEN r.weight ELSE newR.weight END
       DETACH DELETE r`,
      { projectId, duplicateId: duplicate.id, targetId: target.id, id: crypto.randomUUID() },
    );

    await runQuery(
      `MATCH (other:Entity {projectId: $projectId})-[r:REL]->(d:Entity {id: $duplicateId, projectId: $projectId})
       MATCH (t:Entity {id: $targetId, projectId: $projectId})
       MERGE (other)-[newR:REL {kind: r.kind}]->(t)
       ON CREATE SET newR.id = $id,
                     newR.weight = r.weight,
                     newR.metadata = r.metadata,
                     newR.provenance = r.provenance,
                     newR.createdAt = r.createdAt
       ON MATCH SET newR.weight = CASE WHEN coalesce(newR.weight, 0) < coalesce(r.weight, 1) THEN r.weight ELSE newR.weight END
       DETACH DELETE r`,
      { projectId, duplicateId: duplicate.id, targetId: target.id, id: crypto.randomUUID() },
    );

    await runQuery('MATCH (d:Entity {id: $duplicateId, projectId: $projectId}) DETACH DELETE d', { projectId, duplicateId: duplicate.id });
  }

  const inferredFactionEdges = await runQuery(
    `MATCH (c:Entity {projectId: $projectId, type: 'character'})-[r1:REL]->(state:Entity {projectId: $projectId})-[r2:REL]->(f:Entity {projectId: $projectId, type: 'faction'})
     WHERE state.type IN ['knowledge_state', 'character_goal']
       AND r1.kind IN ['has_status', 'has_arc', 'mentions', 'about']
       AND r2.kind IN ['mentions', 'about']
       AND NOT EXISTS { (c)-[:REL {kind:'member_of'}]->(f) }
       AND NOT EXISTS { (c)-[:REL {kind:'ally_of'}]->(f) }
     RETURN c.id as fromId, c.type as fromType, c.label as fromLabel,
            f.id as toId, f.type as toType, f.label as toLabel`,
    { projectId },
  );
  for (const record of inferredFactionEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'ally_of',
      reason: `Associazione inferita tramite stato/obiettivo intermedio con evidenza verso la fazione: ${record.get('fromLabel')} -> ${record.get('toLabel')}`,
      weight: 0.5,
      metadata: { inferred: true, rule: 'char_faction_intermediate' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const eventLocationEdges = await runQuery(
    `MATCH (e:Entity {projectId: $projectId, type: 'timeline_event'})-[:REL {kind:'part_of'}]->(ch:Entity {projectId: $projectId, type: 'chapter'})-[:REL {kind:'located_in'}]->(loc:Entity {projectId: $projectId, type: 'location'})
     WHERE NOT EXISTS { (e)-[:REL {kind:'located_in'}]->(loc) }
     RETURN e.id as fromId, e.type as fromType, e.label as fromLabel,
            loc.id as toId, loc.type as toType, loc.label as toLabel,
            ch.label as chapterLabel`,
    { projectId },
  );
  for (const record of eventLocationEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'located_in',
      reason: `Evento '${record.get('fromLabel')}' inferito nella location '${record.get('toLabel')}' per appartenenza al capitolo '${record.get('chapterLabel')}'.`,
      weight: 0.8,
      metadata: { inferred: true, rule: 'event_chapter_location' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const plotThemeEdges = await runQuery(
    `MATCH (pt:Entity {projectId: $projectId, type: 'plot_thread'})-[:REL {kind:'mentions'}]->(c:Entity {projectId: $projectId, type: 'character'})-[:REL {kind:'has_theme'}]->(theme:Entity {projectId: $projectId, type: 'theme'})
     WHERE NOT EXISTS { (pt)-[:REL {kind:'has_theme'}]->(theme) }
     RETURN pt.id as fromId, pt.type as fromType, pt.label as fromLabel,
            theme.id as toId, theme.type as toType, theme.label as toLabel,
            c.label as characterLabel`,
    { projectId },
  );
  for (const record of plotThemeEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'has_theme',
      reason: `Trama '${record.get('fromLabel')}' associata al tema '${record.get('toLabel')}' per il personaggio coinvolto '${record.get('characterLabel')}'.`,
      weight: 0.5,
      metadata: { inferred: true, rule: 'plot_character_theme' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const stateOrderEdges = await runQuery(
    `MATCH (c:Entity {projectId: $projectId, type: 'character'})-[:REL {kind:'has_arc'}]->(from:Entity {projectId: $projectId, type: 'character_state'})-[:REL {kind:'changes_state'}]->(to:Entity {projectId: $projectId, type: 'character_state'})
     WHERE (c)-[:REL {kind:'has_arc'}]->(to)
       AND NOT EXISTS { (from)-[:REL {kind:'precedes'}]->(to) }
     RETURN from.id as fromId, from.type as fromType, from.label as fromLabel,
            to.id as toId, to.type as toType, to.label as toLabel,
            c.label as characterLabel`,
    { projectId },
  );
  for (const record of stateOrderEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'precedes',
      reason: `Sequenza temporale dello stato di '${record.get('characterLabel')}': ${record.get('fromLabel')} precede ${record.get('toLabel')}.`,
      weight: 0.9,
      metadata: { inferred: true, rule: 'state_precedes' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const causalEdges = await runQuery(
    `MATCH (from:Entity {projectId: $projectId, type: 'timeline_event'})-[:REL {kind:'causes'}]->(:Entity {projectId: $projectId, type: 'timeline_event'})-[:REL {kind:'causes'}]->(to:Entity {projectId: $projectId, type: 'timeline_event'})
     WHERE from.id <> to.id
       AND NOT EXISTS { (from)-[:REL {kind:'sets_up'}]->(to) }
     RETURN from.id as fromId, from.type as fromType, from.label as fromLabel,
            to.id as toId, to.type as toType, to.label as toLabel`,
    { projectId },
  );
  for (const record of causalEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'sets_up',
      reason: `Transitivita causale inferita: '${record.get('fromLabel')}' prepara '${record.get('toLabel')}' tramite un evento intermedio.`,
      weight: 0.6,
      metadata: { inferred: true, rule: 'causes_transitive' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const learningEdges = await runQuery(
    `MATCH (from:Entity {projectId: $projectId, type: 'character'})-[:REL {kind:'does_not_know'}]->(to:Entity {projectId: $projectId, type: 'secret'})-[:REL {kind:'revealed_in'}]->(scene:Entity {projectId: $projectId, type: 'scene'})
     WHERE NOT EXISTS { (from)-[:REL {kind:'learns'}]->(to) }
     RETURN from.id as fromId, from.type as fromType, from.label as fromLabel,
            to.id as toId, to.type as toType, to.label as toLabel,
            scene.id as sceneId, scene.label as sceneLabel`,
    { projectId },
  );
  for (const record of learningEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'learns',
      reason: `Apprendimento inferito: '${record.get('fromLabel')}' impara '${record.get('toLabel')}' per rivelazione nella scena '${record.get('sceneLabel')}'.`,
      weight: 0.7,
      metadata: { inferred: true, rule: 'does_not_know_revealed_in_scene', sceneId: record.get('sceneId'), sceneLabel: record.get('sceneLabel') },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const payoffRows = await runQuery(
    `MATCH (from:Entity {projectId: $projectId, type: 'foreshadowing'})-[rf:REL]-(ch1:Entity {projectId: $projectId, type: 'chapter'})
     MATCH (to:Entity {projectId: $projectId, type: 'revelation'})-[rr:REL]-(ch2:Entity {projectId: $projectId, type: 'chapter'})
     WHERE rf.kind IN ['derived_from', 'part_of', 'about']
       AND rr.kind IN ['derived_from', 'part_of', 'about']
       AND NOT EXISTS { (from)-[:REL {kind:'pays_off'}]->(to) }
     RETURN from.id as fromId, from.type as fromType, from.label as fromLabel,
            to.id as toId, to.type as toType, to.label as toLabel,
            ch1.label as chapterFrom, ch2.label as chapterTo`,
    { projectId },
  );
  for (const record of payoffRows) {
    const leftWords = new Set(String(record.get('fromLabel')).toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter((word) => word.length > 3));
    const rightWords = new Set(String(record.get('toLabel')).toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter((word) => word.length > 3));
    let overlap = 0;
    for (const word of leftWords) if (rightWords.has(word)) overlap++;
    if (overlap < 2) continue;
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'pays_off',
      reason: `Payoff narrativo inferito per similarita delle label: '${record.get('fromLabel')}' si compie in '${record.get('toLabel')}' (${record.get('chapterFrom')} -> ${record.get('chapterTo')}).`,
      weight: 0.8,
      metadata: { inferred: true, rule: 'foreshadowing_revelation_label_similarity' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const commonFactionEdges = await runQuery(
    `MATCH (from:Entity {projectId: $projectId, type: 'character'})-[:REL {kind:'member_of'}]->(faction:Entity {projectId: $projectId, type: 'faction'})<-[:REL {kind:'member_of'}]-(to:Entity {projectId: $projectId, type: 'character'})
     WHERE from.id < to.id
       AND NOT EXISTS { (from)-[:REL {kind:'ally_of'}]->(to) }
       AND NOT EXISTS { (to)-[:REL {kind:'ally_of'}]->(from) }
     RETURN from.id as fromId, from.type as fromType, from.label as fromLabel,
            to.id as toId, to.type as toType, to.label as toLabel,
            faction.label as factionLabel`,
    { projectId },
  );
  for (const record of commonFactionEdges) {
    addInferredEdge(inferredEdges, {
      from: { id: String(record.get('fromId')), type: String(record.get('fromType')), label: String(record.get('fromLabel')) },
      to: { id: String(record.get('toId')), type: String(record.get('toType')), label: String(record.get('toLabel')) },
      kind: 'ally_of',
      reason: `Alleanza debole inferita dall'appartenenza comune alla fazione '${record.get('factionLabel')}': ${record.get('fromLabel')} e ${record.get('toLabel')}.`,
      weight: 0.3,
      metadata: { inferred: true, rule: 'common_faction_member_ally' },
      provenance: { source: 'consolidation_engine', projectId },
    });
  }

  const uniqueEdges = uniqueInferredEdges(inferredEdges.values());

  for (const edge of uniqueEdges) await writeInferredEdge(runQuery, projectId, edge);

  const finalNodesRes = await runQuery('MATCH (n:Entity {projectId: $projectId}) RETURN count(n) as count', { projectId });
  const finalEdgesRes = await runQuery(
    'MATCH (:Entity {projectId: $projectId})-[r:REL]->(:Entity {projectId: $projectId}) RETURN count(r) as count',
    { projectId },
  );

  return {
    ok: true,
    mergedNodes,
    inferredEdges: uniqueEdges.map(compactEdge),
    stats: {
      nodesBefore,
      nodesAfter: toInt(finalNodesRes[0]?.get('count') ?? 0),
      edgesBefore,
      edgesAfter: toInt(finalEdgesRes[0]?.get('count') ?? 0),
    },
  };
}
