import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';

const EXPECTED = {
  planNodes: 11,
  migrateNodes: 10,
  deleteNodes: 1,
};

const MIGRATION_PLAN = [
  {
    nodeId: '006acfe1-e978-448e-9e2f-043b402438af',
    type: 'character',
    label: 'Asia',
    primarySectionKey: '4.4.10',
    evidence: [
      {
        sectionKey: '4.4.10',
        textSnippet: 'Il Nonno affida la piuma mostrata nel Prologo alla piu piccola, Asia.',
      },
      {
        sectionKey: '4.5.1.1',
        textSnippet: 'Il Nonno racconta gli eventi passati alle sue giovani nipotine, Asia ed Elea.',
      },
      {
        sectionKey: '2.6.4.1',
        textSnippet: 'Marta e madre di Asia ed Elea.',
      },
    ],
  },
  {
    nodeId: '3bb5ba62-b13d-4044-b6b7-378d62f0c7c9',
    type: 'character',
    label: 'Elea',
    primarySectionKey: '4.4.10',
    evidence: [
      {
        sectionKey: '4.4.10',
        textSnippet: 'Elea comprende che la storia narrata e quella del Nonno e della Nonna Lisa.',
      },
      {
        sectionKey: '4.5.1.1',
        textSnippet: 'Il Nonno racconta gli eventi passati alle sue giovani nipotine, Asia ed Elea.',
      },
      {
        sectionKey: '2.6.4.1',
        textSnippet: 'Marta e madre di Asia ed Elea.',
      },
    ],
  },
  {
    nodeId: '527720a3-10cf-4ad9-bc25-c93292760050',
    type: 'character',
    label: 'Marta',
    primarySectionKey: '2.6.4.1',
    evidence: [
      {
        sectionKey: '2.6.4.1',
        textSnippet: 'Marta e figlia adulta di Gabriele e Lisa, madre di Asia ed Elea.',
      },
      {
        sectionKey: '4.4.10',
        textSnippet: 'La figlia del Nonno, Marta, torna a casa con suo marito durante l Epilogo.',
      },
    ],
  },
  {
    nodeId: '496aa500-8970-42b7-8e89-71593853f11f',
    type: 'character_state',
    label: 'Personalita iniziale di Gabriele',
    primarySectionKey: '2.1.1.3',
    evidence: [
      {
        sectionKey: '2.1.1.3',
        textSnippet: 'Timido, introverso, insicuro, profondamente sensibile e goffo.',
      },
    ],
  },
  {
    nodeId: '8e62a765-8370-41c9-880f-8615d8a0a209',
    type: 'character_trait',
    label: 'Valori non negoziabili di Gabriele',
    primarySectionKey: '2.1.1.7.1',
    evidence: [
      {
        sectionKey: '2.1.1.7.1',
        textSnippet: 'Lealta, giustizia, protezione degli innocenti e amore autentico orientano Gabriele.',
      },
    ],
  },
  {
    nodeId: 'bb3c391a-9359-4d88-aade-075cc929e3de',
    type: 'narrative_constraint',
    label: 'Punti di rottura operativi di Gabriele',
    primarySectionKey: '2.1.1.7.2',
    evidence: [
      {
        sectionKey: '2.1.1.7.2',
        textSnippet: 'La minaccia diretta alla vita o al benessere di Lisa spinge Gabriele a usare i poteri.',
      },
    ],
  },
  {
    nodeId: 'f8ba15dd-6ebd-474c-a68e-ddbf2499b903',
    type: 'plot_thread',
    label: 'Lisa futura comunicazione etica e giustizia',
    primarySectionKey: '2.1.2.19',
    evidence: [
      {
        sectionKey: '2.1.2.19',
        textSnippet: 'Lisa intraprende comunicazione, giornalismo, radio, editoria o cause sociali con impegno verso verita e giustizia.',
      },
    ],
  },
  {
    nodeId: '738aa4a2-203c-4e28-afec-462058d24295',
    type: 'precognitive_data',
    label: 'Futuro post-romanzo di Gabriele',
    primarySectionKey: '2.1.1.19',
    evidence: [
      {
        sectionKey: '2.1.1.19',
        textSnippet: 'Come umano, Gabriele vivra una vita piena accanto a Lisa, con Marta, Asia, Elea e Trevor.',
      },
    ],
  },
  {
    nodeId: 'daa3a754-5c95-4631-8b03-a50598aef708',
    type: 'relationship_dynamic',
    label: 'Lisa-Trevor amicizia adulta duratura',
    primarySectionKey: '2.1.2.19',
    evidence: [
      {
        sectionKey: '2.1.2.19',
        textSnippet: 'Il rapporto Lisa-Trevor si placa e diventa una solida amicizia duratura fondata su Gabriele e sul segreto condiviso.',
      },
    ],
  },
  {
    nodeId: '7280d9c3-960d-44e0-a8a9-9d7245ec71af',
    type: 'relationship_dynamic',
    label: 'Relazioni chiave di Gabriele',
    primarySectionKey: '2.1.1.15',
    evidence: [
      {
        sectionKey: '2.1.1.15',
        textSnippet: 'Le relazioni chiave di Gabriele vanno verificate nella cronologia dettagliata prima di scrivere interazioni.',
      },
    ],
  },
];

const DELETE_PLAN = [
  {
    nodeId: 'b392a47f-e618-48e5-adb3-6fd7531376d4',
    type: 'relationship_dynamic',
    label: 'Elena Costa - Relazioni Chiave',
    reason: 'structural_title_only_not_atomic_canon',
    replacementSectionKeys: ['2.4.1.8.1', '2.4.1.8.2', '2.4.1.8.3', '2.4.1.8.4', '2.4.1.8.5'],
  },
];

function loadEnv() {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function parseArgs() {
  return { apply: process.argv.includes('--apply'), dryRun: !process.argv.includes('--apply') };
}

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`preflight_count_mismatch:${label}: expected ${expected}, got ${actual}`);
}

function stripObsoleteRefs(value) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map(stripObsoleteRefs).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (['sectionKey', 'sourceSectionKey', 'previousSectionKey', 'sectionKeyMapped'].includes(key)) continue;
      const transformed = stripObsoleteRefs(nested);
      if (transformed !== undefined) out[key] = transformed;
    }
    return out;
  }
  if (typeof value === 'string' && value.includes(`${SOURCE_ID}::`)) return undefined;
  return value;
}

async function globalAudit(session, projectId) {
  const count = async (cypher) => {
    const result = await session.run(cypher, { projectId });
    return result.records[0].get('count').toNumber();
  };
  return {
    nodes: await count('MATCH (n:Entity {projectId: $projectId}) RETURN count(n) AS count'),
    edges: await count('MATCH (:Entity {projectId: $projectId})-[r:REL]->(:Entity {projectId: $projectId}) RETURN count(r) AS count'),
    orphanNodes: await count('MATCH (n:Entity {projectId: $projectId}) WHERE NOT (n)--() RETURN count(n) AS count'),
    relatedToTotal: await count("MATCH (:Entity {projectId: $projectId})-[r:REL {kind:'related_to'}]->(:Entity {projectId: $projectId}) RETURN count(r) AS count"),
    nonRelPhysicalEdges: await count("MATCH (:Entity {projectId: $projectId})-[r]->(:Entity {projectId: $projectId}) WHERE type(r) <> 'REL' RETURN count(r) AS count"),
  };
}

async function loadLiveGraph(session, projectId, nodeIds) {
  const nodeResult = await session.run(
    `
    MATCH (n:Entity {projectId: $projectId})
    WHERE n.id IN $nodeIds
    RETURN n.id AS id, n.type AS type, n.label AS label, n.content AS content,
           n.metadata AS metadata, n.provenance AS provenance,
           n.createdAt AS createdAt, n.updatedAt AS updatedAt
    `,
    { projectId, nodeIds },
  );
  const nodes = new Map(nodeResult.records.map((record) => [record.get('id'), {
    id: record.get('id'),
    type: record.get('type'),
    label: record.get('label'),
    content: String(record.get('content') ?? ''),
    metadata: safeJson(record.get('metadata')),
    provenance: safeJson(record.get('provenance')),
    createdAt: String(record.get('createdAt') ?? ''),
    updatedAt: String(record.get('updatedAt') ?? ''),
  }]));

  const edgeResult = await session.run(
    `
    MATCH (a:Entity {projectId: $projectId})-[r:REL]-(b:Entity {projectId: $projectId})
    WHERE a.id IN $nodeIds OR b.id IN $nodeIds
    RETURN DISTINCT r.id AS id, r.kind AS kind, r.weight AS weight,
           r.metadata AS metadata, r.provenance AS provenance, r.createdAt AS createdAt,
           startNode(r).id AS fromId, endNode(r).id AS toId
    ORDER BY id
    `,
    { projectId, nodeIds },
  );
  return {
    nodes,
    edges: edgeResult.records.map((record) => ({
      id: record.get('id'),
      kind: record.get('kind'),
      weight: Number(record.get('weight') ?? 1),
      metadata: safeJson(record.get('metadata')),
      provenance: safeJson(record.get('provenance')),
      createdAt: String(record.get('createdAt') ?? ''),
      fromId: record.get('fromId'),
      toId: record.get('toId'),
    })),
  };
}

async function loadSections(session, projectId) {
  const keys = [...new Set([
    ...MIGRATION_PLAN.flatMap((item) => item.evidence.map((evidence) => evidence.sectionKey)),
    ...DELETE_PLAN.flatMap((item) => item.replacementSectionKeys),
  ])];
  const result = await session.run(
    `
    MATCH (s:Entity {projectId: $projectId, type: 'bible_section'})
    WHERE s.label STARTS WITH $prefix
    RETURN s.id AS id, s.label AS label, s.metadata AS metadata, s.content AS content
    `,
    { projectId, prefix: `${SOURCE_ID}::` },
  );
  const sections = new Map();
  for (const record of result.records) {
    const metadata = safeJson(record.get('metadata'));
    const sectionKey = String(metadata.sectionKey ?? '');
    if (keys.includes(sectionKey)) {
      sections.set(sectionKey, {
        id: record.get('id'),
        label: record.get('label'),
        metadata,
        content: String(record.get('content') ?? ''),
      });
    }
  }
  const missing = keys.filter((key) => !sections.has(key));
  if (missing.length) throw new Error(`missing_target_sections: ${missing.join(', ')}`);
  return sections;
}

function verifyLiveIdentities(liveGraph) {
  const expectedNodes = [...MIGRATION_PLAN, ...DELETE_PLAN];
  assertEqual('plan_nodes', expectedNodes.length, EXPECTED.planNodes);
  assertEqual('migrate_nodes', MIGRATION_PLAN.length, EXPECTED.migrateNodes);
  assertEqual('delete_nodes', DELETE_PLAN.length, EXPECTED.deleteNodes);
  assertEqual('live_nodes', liveGraph.nodes.size, expectedNodes.length);
  const errors = [];
  for (const item of expectedNodes) {
    const node = liveGraph.nodes.get(item.nodeId);
    if (!node) {
      errors.push({ id: item.nodeId, reason: 'missing_live_node' });
      continue;
    }
    const normalizedLiveLabel = node.label.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const normalizedPlanLabel = item.label.normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (node.type !== item.type || normalizedLiveLabel !== normalizedPlanLabel) {
      errors.push({ id: item.nodeId, reason: 'identity_mismatch', expected: item, actual: { type: node.type, label: node.label } });
    }
  }
  if (errors.length) throw new Error(`live_identity_preflight_failed: ${JSON.stringify(errors)}`);
}

function buildMigrationPatch(node, item, sections) {
  const metadata = stripObsoleteRefs(node.metadata) ?? {};
  const provenance = stripObsoleteRefs(node.provenance) ?? {};
  metadata.sourceId = SOURCE_ID;
  metadata.canonStatus = 'canonical';
  metadata.evidence = item.evidence.map((evidence) => ({
    sourceId: SOURCE_ID,
    sectionKey: evidence.sectionKey,
    sectionLabel: sections.get(evidence.sectionKey).label,
    textSnippet: evidence.textSnippet,
  }));
  metadata.ambiguousBibleResolution = {
    source: 'resolve_ambiguous_bible_canon',
    resolvedAt: new Date().toISOString(),
    oldSectionKeysRemoved: item.nodeId === '006acfe1-e978-448e-9e2f-043b402438af'
      ? ['3.2.9', '3.8.2']
      : item.nodeId === '3bb5ba62-b13d-4044-b6b7-378d62f0c7c9'
        ? ['3.2.9', '3.8.3']
        : item.nodeId === '527720a3-10cf-4ad9-bc25-c93292760050'
          ? ['3.2.9']
          : [],
    validatedBy: 'galaxy-task-validator',
  };
  provenance.source = 'resolve_ambiguous_bible_canon';
  provenance.sourceId = SOURCE_ID;
  provenance.sectionKey = item.primarySectionKey;
  return { metadata, provenance };
}

function buildPlan(liveGraph, sections) {
  const migrateNodes = MIGRATION_PLAN.map((item) => {
    const node = liveGraph.nodes.get(item.nodeId);
    const patch = buildMigrationPatch(node, item, sections);
    return {
      nodeId: item.nodeId,
      type: node.type,
      label: node.label,
      primarySectionKey: item.primarySectionKey,
      sectionKeys: item.evidence.map((evidence) => evidence.sectionKey),
      patch,
    };
  });
  const deleteNodes = DELETE_PLAN.map((item) => {
    const node = liveGraph.nodes.get(item.nodeId);
    return {
      nodeId: item.nodeId,
      type: node.type,
      label: node.label,
      reason: item.reason,
      replacementSectionKeys: item.replacementSectionKeys,
      incidentEdges: liveGraph.edges.filter((edge) => edge.fromId === item.nodeId || edge.toId === item.nodeId),
    };
  });
  const derivedFromEdges = migrateNodes.flatMap((item) => item.sectionKeys.map((sectionKey) => ({
    fromId: item.nodeId,
    toId: sections.get(sectionKey).id,
    sectionKey,
    kind: 'derived_from',
    weight: 1,
  })));
  return { migrateNodes, deleteNodes, derivedFromEdges };
}

async function writeReport(plan, beforeAudit, dryRun) {
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    sourceId: SOURCE_ID,
    beforeAudit,
    summary: {
      migrateNodes: plan.migrateNodes.length,
      deleteNodes: plan.deleteNodes.length,
      derivedFromEdges: plan.derivedFromEdges.length,
    },
    migrateNodes: plan.migrateNodes.map((item) => ({
      nodeId: item.nodeId,
      type: item.type,
      label: item.label,
      primarySectionKey: item.primarySectionKey,
      sectionKeys: item.sectionKeys,
    })),
    deleteNodes: plan.deleteNodes,
    derivedFromEdges: plan.derivedFromEdges,
  };
  const outDir = path.join(ROOT, 'dev-data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-ambiguous-canon-resolution-${dryRun ? 'dry-run' : 'apply'}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

async function writeBackup(liveGraph, nodeIds) {
  const backup = {
    source: 'resolve_ambiguous_bible_canon',
    sourceId: SOURCE_ID,
    createdAt: new Date().toISOString(),
    nodes: nodeIds.map((id) => liveGraph.nodes.get(id)).filter(Boolean),
    relationships: liveGraph.edges,
    counts: { nodes: nodeIds.length, relationships: liveGraph.edges.length },
  };
  const outDir = path.join(ROOT, 'dev-data', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-ambiguous-canon-resolution-backup.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  const verified = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assertEqual('backup_nodes', verified.counts.nodes, nodeIds.length);
  assertEqual('backup_relationships', verified.counts.relationships, liveGraph.edges.length);
  return outPath;
}

async function applyPlan(session, projectId, plan, liveGraph, nodeIds) {
  const backupPath = await writeBackup(liveGraph, nodeIds);
  const tx = session.beginTransaction();
  try {
    for (const item of plan.migrateNodes) {
      await tx.run(
        `
        MATCH (n:Entity {projectId: $projectId, id: $nodeId})
        SET n.metadata = $metadata,
            n.provenance = $provenance,
            n.updatedAt = $updatedAt
        WITH n
        OPTIONAL MATCH (n)-[old:REL {kind: 'derived_from'}]->(s:Entity {projectId: $projectId, type: 'bible_section'})
        WHERE s.label STARTS WITH $prefix
        DELETE old
        `,
        {
          projectId,
          nodeId: item.nodeId,
          metadata: JSON.stringify(item.patch.metadata),
          provenance: JSON.stringify(item.patch.provenance),
          updatedAt: new Date().toISOString(),
          prefix: `${SOURCE_ID}::`,
        },
      );
    }
    for (const edge of plan.derivedFromEdges) {
      await tx.run(
        `
        MATCH (a:Entity {projectId: $projectId, id: $fromId})
        MATCH (b:Entity {projectId: $projectId, id: $toId})
        MERGE (a)-[r:REL {kind: 'derived_from'}]->(b)
        ON CREATE SET r.id = $id,
          r.weight = $weight,
          r.metadata = $metadata,
          r.provenance = $provenance,
          r.createdAt = $createdAt
        ON MATCH SET r.weight = CASE WHEN coalesce(r.weight, 0) < $weight THEN $weight ELSE r.weight END,
          r.metadata = $metadata,
          r.provenance = $provenance
        `,
        {
          projectId,
          fromId: edge.fromId,
          toId: edge.toId,
          id: crypto.randomUUID(),
          weight: edge.weight,
          metadata: JSON.stringify({ sourceId: SOURCE_ID, sectionKey: edge.sectionKey, ambiguousResolution: true }),
          provenance: JSON.stringify({ source: 'resolve_ambiguous_bible_canon', sourceId: SOURCE_ID, sectionKey: edge.sectionKey }),
          createdAt: new Date().toISOString(),
        },
      );
    }
    await tx.run(
      `
      MATCH (n:Entity {projectId: $projectId})
      WHERE n.id IN $deleteNodeIds
      DETACH DELETE n
      `,
      { projectId, deleteNodeIds: plan.deleteNodes.map((item) => item.nodeId) },
    );
    await tx.commit();
    return { backupPath };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function main() {
  loadEnv();
  const { apply, dryRun } = parseArgs();
  const projectId = process.env.PROJECT_ID || 'romanzo-gabriele';
  const nodeIds = [...MIGRATION_PLAN.map((item) => item.nodeId), ...DELETE_PLAN.map((item) => item.nodeId)];
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const beforeAudit = await globalAudit(session, projectId);
    const liveGraph = await loadLiveGraph(session, projectId, nodeIds);
    verifyLiveIdentities(liveGraph);
    const sections = await loadSections(session, projectId);
    const plan = buildPlan(liveGraph, sections);
    assertEqual('dry_migrate_nodes', plan.migrateNodes.length, EXPECTED.migrateNodes);
    assertEqual('dry_delete_nodes', plan.deleteNodes.length, EXPECTED.deleteNodes);
    const reportPath = await writeReport(plan, beforeAudit, dryRun);
    const summary = {
      ok: true,
      dryRun,
      reportPath,
      beforeAudit,
      plan: {
        migrateNodes: plan.migrateNodes.length,
        deleteNodes: plan.deleteNodes.length,
        derivedFromEdges: plan.derivedFromEdges.length,
      },
    };
    if (!apply) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    const applied = await applyPlan(session, projectId, plan, liveGraph, nodeIds);
    const afterAudit = await globalAudit(session, projectId);
    console.log(JSON.stringify({ ...summary, dryRun: false, applied, afterAudit }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
