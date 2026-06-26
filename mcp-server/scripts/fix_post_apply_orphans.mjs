import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';

const EXPECTED_ORPHANS = {
  total: 58,
  byType: {
    bible_claim: 1,
    continuity_finding: 54,
    narrative_constraint: 2,
    timeline_event: 1,
  },
};
const EXPECTED_RELINK_EDGES = 6;

const RELINK_PLAN = [
  {
    nodeId: 'f6022904-c621-4c06-97dc-675455c4957f',
    type: 'narrative_constraint',
    label: 'Cristiano ha divieto assoluto di redenzione',
    sections: [
      {
        sectionKey: '2.2.2',
        textSnippet: "DIVIETO ASSOLUTO REDENZIONE: Cristiano rappresenta l'immaturità e incapacità di crescita. VIETATO qualsiasi percorso di redenzione o evoluzione positiva.",
      },
    ],
  },
  {
    nodeId: 'd0382a88-1314-477a-9998-c8c04ba5634a',
    type: 'narrative_constraint',
    label: 'Personaggi secondari funzionali hanno ruolo limitato',
    sections: [
      {
        sectionKey: '2.5',
        textSnippet: 'PERSONAGGI SECONDARI FUNZIONALI',
      },
      {
        sectionKey: '2.5.3.3.2',
        textSnippet: 'MAI svilupparli oltre il loro momento specifico; MAI trasformarli in personaggi ricorrenti.',
      },
      {
        sectionKey: '2.5.3.3.3',
        textSnippet: "Limitare apparizione al singolo evento funzionale; mantenere reazioni nell'ambito umano normale.",
      },
    ],
  },
  {
    nodeId: 'f3068dd0-6255-488c-93d6-4f4f9106ff5a',
    type: 'timeline_event',
    label: 'Scoperta pubblica dell identità SpeedyGonzy',
    sections: [
      {
        sectionKey: '2.2.1.2',
        textSnippet: "La scoperta della sua identità da parte di Cristiano (17/12/2020) e la conseguente distruzione del laptop rappresentano la perdita dell'anonimato.",
      },
      {
        sectionKey: '4.3.10',
        textSnippet: "Indagine di Cristiano: Utilizza la sua rete di \"informatori\" a scuola",
      },
    ],
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
  if (actual !== expected) throw new Error(`preflight_mismatch:${label}: expected ${expected}, got ${actual}`);
}

async function loadOrphans(session, projectId) {
  const result = await session.run(
    `
    MATCH (n:Entity {projectId: $projectId})
    WHERE NOT (n)--()
    RETURN n.id AS id, n.type AS type, n.label AS label, n.content AS content,
           n.metadata AS metadata, n.provenance AS provenance
    ORDER BY n.type, n.label
    `,
    { projectId },
  );
  return result.records.map((record) => ({
    id: record.get('id'),
    type: record.get('type'),
    label: record.get('label'),
    content: String(record.get('content') ?? ''),
    metadata: safeJson(record.get('metadata')),
    provenance: safeJson(record.get('provenance')),
  }));
}

function verifyExpectedOrphans(orphans) {
  assertEqual('total_orphans', orphans.length, EXPECTED_ORPHANS.total);
  const byType = {};
  for (const orphan of orphans) byType[orphan.type] = (byType[orphan.type] ?? 0) + 1;
  for (const [type, count] of Object.entries(EXPECTED_ORPHANS.byType)) {
    assertEqual(`orphans_${type}`, byType[type] ?? 0, count);
  }
  const unexpected = Object.keys(byType).filter((type) => !(type in EXPECTED_ORPHANS.byType));
  if (unexpected.length) throw new Error(`unexpected_orphan_types: ${unexpected.join(', ')}`);
}

async function loadSections(session, projectId) {
  const keys = [...new Set(RELINK_PLAN.flatMap((item) => item.sections.map((section) => section.sectionKey)))];
  const result = await session.run(
    `
    MATCH (s:Entity {projectId: $projectId, type: 'bible_section'})
    WHERE s.label STARTS WITH $prefix
    RETURN s.id AS id, s.label AS label, s.content AS content, s.metadata AS metadata
    `,
    { projectId, prefix: `${SOURCE_ID}::` },
  );
  const sections = new Map();
  for (const record of result.records) {
    const metadata = safeJson(record.get('metadata'));
    const key = String(metadata.sectionKey ?? '');
    if (keys.includes(key)) {
      sections.set(key, {
        id: record.get('id'),
        label: record.get('label'),
        content: String(record.get('content') ?? ''),
        metadata,
      });
    }
  }
  const missing = keys.filter((key) => !sections.has(key));
  if (missing.length) throw new Error(`missing_sections: ${missing.join(', ')}`);
  return sections;
}

function buildPlan(orphans, sections) {
  const relinkIds = new Set(RELINK_PLAN.map((item) => item.nodeId));
  const deleteNodes = orphans
    .filter((orphan) => !relinkIds.has(orphan.id))
    .map((orphan) => ({
      nodeId: orphan.id,
      type: orphan.type,
      label: orphan.label,
      reason: orphan.type === 'continuity_finding'
        ? 'orphan_diagnostic_after_obsolete_canon_delete'
        : 'orphan_noncanonical_claim_without_updated_bible_support',
    }));
  const relinkNodes = RELINK_PLAN.map((item) => {
    const orphan = orphans.find((node) => node.id === item.nodeId);
    if (!orphan) throw new Error(`relink_node_missing_from_orphans: ${item.nodeId}`);
    if (orphan.type !== item.type || orphan.label !== item.label) throw new Error(`relink_node_identity_mismatch: ${item.nodeId}`);
    for (const section of item.sections) {
      const target = sections.get(section.sectionKey);
      if (!target.content.includes(section.textSnippet.slice(0, 30)) && section.sectionKey !== '2.5') {
        throw new Error(`section_snippet_not_found:${item.nodeId}:${section.sectionKey}`);
      }
    }
    return {
      nodeId: item.nodeId,
      type: item.type,
      label: item.label,
      evidence: item.sections.map((section) => ({
        sourceId: SOURCE_ID,
        sectionKey: section.sectionKey,
        sectionLabel: sections.get(section.sectionKey).label,
        textSnippet: section.textSnippet,
      })),
      edgeTargets: item.sections.map((section) => ({
        sectionKey: section.sectionKey,
        sectionId: sections.get(section.sectionKey).id,
      })),
    };
  });
  return { deleteNodes, relinkNodes };
}

async function writeReport(plan, dryRun) {
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    summary: {
      deleteNodes: plan.deleteNodes.length,
      relinkNodes: plan.relinkNodes.length,
      relinkEdges: plan.relinkNodes.reduce((sum, item) => sum + item.edgeTargets.length, 0),
    },
    deleteNodes: plan.deleteNodes,
    relinkNodes: plan.relinkNodes,
  };
  const outDir = path.join(ROOT, 'dev-data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-post-apply-orphan-fix-${dryRun ? 'dry-run' : 'apply'}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

async function writeBackup(session, projectId, orphans) {
  const ids = orphans.map((node) => node.id);
  const relResult = await session.run(
    `
    MATCH (a:Entity {projectId: $projectId})-[r:REL]-(b:Entity {projectId: $projectId})
    WHERE a.id IN $ids OR b.id IN $ids
    RETURN DISTINCT r.id AS id, r.kind AS kind, r.weight AS weight, r.metadata AS metadata,
           r.provenance AS provenance, startNode(r).id AS fromId, endNode(r).id AS toId
    `,
    { projectId, ids },
  );
  const backup = {
    source: 'fix_post_apply_orphans',
    sourceId: SOURCE_ID,
    createdAt: new Date().toISOString(),
    nodes: orphans,
    relationships: relResult.records.map((record) => ({
      id: record.get('id'),
      kind: record.get('kind'),
      weight: Number(record.get('weight') ?? 1),
      metadata: safeJson(record.get('metadata')),
      provenance: safeJson(record.get('provenance')),
      fromId: record.get('fromId'),
      toId: record.get('toId'),
    })),
    counts: { nodes: orphans.length, relationships: relResult.records.length },
  };
  const outDir = path.join(ROOT, 'dev-data', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-post-apply-orphans-backup.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  const verified = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assertEqual('backup_nodes', verified.counts.nodes, orphans.length);
  assertEqual('backup_relationships', verified.counts.relationships, relResult.records.length);
  return outPath;
}

async function applyPlan(session, projectId, plan, orphans) {
  const backupPath = await writeBackup(session, projectId, orphans);
  const tx = session.beginTransaction();
  try {
    for (const item of plan.relinkNodes) {
      await tx.run(
        `
        MATCH (n:Entity {projectId: $projectId, id: $nodeId})
        SET n.metadata = $metadata,
            n.provenance = $provenance,
            n.updatedAt = $updatedAt
        `,
        {
          projectId,
          nodeId: item.nodeId,
          metadata: JSON.stringify({
            canonStatus: 'canonical',
            sourceId: SOURCE_ID,
            family: item.type === 'timeline_event' ? 'timeline' : 'ai_controls',
            granularity: 'atomic',
            evidence: item.evidence,
            repairedBy: 'fix_post_apply_orphans',
          }),
          provenance: JSON.stringify({
            source: 'fix_post_apply_orphans',
            sourceId: SOURCE_ID,
            sectionKey: item.evidence[0].sectionKey,
          }),
          updatedAt: new Date().toISOString(),
        },
      );
      for (const target of item.edgeTargets) {
        await tx.run(
          `
          MATCH (n:Entity {projectId: $projectId, id: $nodeId})
          MATCH (s:Entity {projectId: $projectId, id: $sectionId})
          MERGE (n)-[r:REL {kind: 'derived_from'}]->(s)
          ON CREATE SET r.id = randomUUID(),
            r.weight = 1,
            r.metadata = $metadata,
            r.provenance = $provenance,
            r.createdAt = $createdAt
          ON MATCH SET r.metadata = $metadata,
            r.provenance = $provenance
          `,
          {
            projectId,
            nodeId: item.nodeId,
            sectionId: target.sectionId,
            metadata: JSON.stringify({ sourceId: SOURCE_ID, sectionKey: target.sectionKey, orphanRepair: true }),
            provenance: JSON.stringify({ source: 'fix_post_apply_orphans', sourceId: SOURCE_ID, sectionKey: target.sectionKey }),
            createdAt: new Date().toISOString(),
          },
        );
      }
    }
    await tx.run(
      `
      MATCH (n:Entity {projectId: $projectId})
      WHERE n.id IN $deleteIds
      DETACH DELETE n
      `,
      { projectId, deleteIds: plan.deleteNodes.map((node) => node.nodeId) },
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
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const orphans = await loadOrphans(session, projectId);
    verifyExpectedOrphans(orphans);
    const sections = await loadSections(session, projectId);
    const plan = buildPlan(orphans, sections);
    assertEqual('delete_nodes', plan.deleteNodes.length, 55);
    assertEqual('relink_nodes', plan.relinkNodes.length, 3);
    const relinkEdges = plan.relinkNodes.reduce((sum, item) => sum + item.edgeTargets.length, 0);
    assertEqual('relink_edges', relinkEdges, EXPECTED_RELINK_EDGES);
    const reportPath = await writeReport(plan, dryRun);
    if (!apply) {
      console.log(JSON.stringify({ ok: true, dryRun: true, reportPath, summary: { deleteNodes: 55, relinkNodes: 3, relinkEdges } }, null, 2));
      return;
    }
    const applied = await applyPlan(session, projectId, plan, orphans);
    console.log(JSON.stringify({ ok: true, dryRun: false, reportPath, applied, summary: { deleteNodes: 55, relinkNodes: 3, relinkEdges } }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
