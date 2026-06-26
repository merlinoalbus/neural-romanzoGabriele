import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';
const VALIDATED_REPORT_NAME = '2026-06-26T22-07-28-390Z-bibbia-gabriele-2025-obsolete-canon-analysis.json';
const DEFAULT_REPORT_PATH = path.join(ROOT, 'dev-data', 'reports', VALIDATED_REPORT_NAME);
const EXPECTED = {
  canonicalNodes: 927,
  obsoleteRows: 949,
  migrabileRows: 217,
  ambiguoRows: 11,
  nonSostenutoRows: 721,
  allMigrabileNodes: 199,
  mixedNodes: 12,
  ambiguousNodes: 11,
  deleteCandidates: 705,
};
const TECHNICAL_TYPES = new Set([
  'bible_section',
  'bible_outline',
  'bible_candidate',
  'bible_coverage_finding',
  'bible_mapping_batch',
]);

function loadEnv() {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const reportArgIndex = args.indexOf('--report');
  const reportPath = reportArgIndex >= 0 ? path.resolve(args[reportArgIndex + 1] ?? '') : DEFAULT_REPORT_PATH;
  if (reportArgIndex >= 0 && !args[reportArgIndex + 1]) throw new Error('missing_report_path');
  return { apply, dryRun: !apply, reportPath };
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

function stableKey(value) {
  return JSON.stringify(value ?? null, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.keys(inner).sort().reduce((acc, key) => {
          acc[key] = inner[key];
          return acc;
        }, {})
      : inner,
  );
}

function collectSectionRefs(value, refs = [], currentPath = '$') {
  if (value == null) return refs;
  if (typeof value === 'string') {
    if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
      try {
        collectSectionRefs(JSON.parse(value), refs, currentPath);
      } catch {
        // Fall through to regex scanning.
      }
    }
    const quotedKeyRe = /"(?:sectionKey|sourceSectionKey|previousSectionKey)"\s*:\s*"([^"]+)"/g;
    const labelRe = /bibbia-gabriele-2025::(\d+(?:\.\d+)*|[a-z0-9][a-z0-9.\-]*)/gi;
    for (const match of value.matchAll(quotedKeyRe)) refs.push({ sectionKey: match[1], path: `${currentPath}:json-string` });
    for (const match of value.matchAll(labelRe)) refs.push({ sectionKey: match[1], path: `${currentPath}:label-string` });
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSectionRefs(item, refs, `${currentPath}[${index}]`));
    return refs;
  }
  if (typeof value !== 'object') return refs;
  for (const [key, nested] of Object.entries(value)) {
    if (['sectionKey', 'sourceSectionKey', 'previousSectionKey'].includes(key) && typeof nested === 'string') {
      refs.push({ sectionKey: nested, path: `${currentPath}.${key}` });
    }
    collectSectionRefs(nested, refs, `${currentPath}.${key}`);
  }
  return refs;
}

function loadValidatedReport(reportPath) {
  if (path.basename(reportPath) !== VALIDATED_REPORT_NAME) {
    throw new Error(`report_not_validated: expected ${VALIDATED_REPORT_NAME}, got ${path.basename(reportPath)}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const rows = report.rows ?? [];
  const byStatus = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
  const byNode = groupRowsByNode(rows);
  const classes = classifyNodes(byNode);
  assertEqual('canonicalNodes', byNode.size, EXPECTED.canonicalNodes);
  assertEqual('obsoleteRows', rows.length, EXPECTED.obsoleteRows);
  assertEqual('migrabileRows', byStatus.migrabile ?? 0, EXPECTED.migrabileRows);
  assertEqual('ambiguoRows', byStatus.ambiguo ?? 0, EXPECTED.ambiguoRows);
  assertEqual('nonSostenutoRows', byStatus.non_sostenuto ?? 0, EXPECTED.nonSostenutoRows);
  assertEqual('allMigrabileNodes', classes.allMigrabile.length, EXPECTED.allMigrabileNodes);
  assertEqual('mixedNodes', classes.mixed.length, EXPECTED.mixedNodes);
  assertEqual('ambiguousNodes', classes.ambiguous.length, EXPECTED.ambiguousNodes);
  assertEqual('deleteCandidates', classes.deleteObsolete.length, EXPECTED.deleteCandidates);
  return { report, rows, byNode, classes };
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`preflight_count_mismatch:${label}: expected ${expected}, got ${actual}`);
}

function groupRowsByNode(rows) {
  const byNode = new Map();
  for (const row of rows) {
    if (!byNode.has(row.nodeId)) byNode.set(row.nodeId, []);
    byNode.get(row.nodeId).push(row);
  }
  return byNode;
}

function classifyNodes(byNode) {
  const allMigrabile = [];
  const mixed = [];
  const ambiguous = [];
  const deleteObsolete = [];
  for (const [nodeId, rows] of byNode.entries()) {
    if (rows.some((row) => row.status === 'ambiguo')) ambiguous.push({ nodeId, rows });
    else if (rows.every((row) => row.status === 'migrabile')) allMigrabile.push({ nodeId, rows });
    else if (rows.every((row) => row.status === 'non_sostenuto')) deleteObsolete.push({ nodeId, rows });
    else mixed.push({ nodeId, rows });
  }
  return { allMigrabile, mixed, ambiguous, deleteObsolete };
}

async function loadLiveGraph(session, projectId, nodeIds) {
  const nodeResult = await session.run(
    `
    MATCH (n:Entity {projectId: $projectId})
    WHERE n.id IN $nodeIds
    RETURN n.id AS id, n.type AS type, n.label AS label, n.content AS content,
           n.metadata AS metadata, n.provenance AS provenance, n.createdAt AS createdAt, n.updatedAt AS updatedAt
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
    RETURN DISTINCT r.id AS id, r.kind AS kind, r.weight AS weight, r.metadata AS metadata,
           r.provenance AS provenance, r.createdAt AS createdAt,
           startNode(r).id AS fromId, endNode(r).id AS toId,
           a.id AS matchedA, b.id AS matchedB
    ORDER BY id
    `,
    { projectId, nodeIds },
  );
  const edgeById = new Map();
  for (const record of edgeResult.records) {
    edgeById.set(record.get('id'), {
      id: record.get('id'),
      kind: record.get('kind'),
      weight: Number(record.get('weight') ?? 1),
      metadata: safeJson(record.get('metadata')),
      provenance: safeJson(record.get('provenance')),
      createdAt: String(record.get('createdAt') ?? ''),
      fromId: record.get('fromId'),
      toId: record.get('toId'),
    });
  }
  return { nodes, edges: [...edgeById.values()] };
}

function verifyLiveGraph(byNode, liveNodes) {
  const errors = [];
  for (const [nodeId, rows] of byNode.entries()) {
    const node = liveNodes.get(nodeId);
    if (!node) {
      errors.push({ nodeId, reason: 'missing_live_node' });
      continue;
    }
    if (node.type !== rows[0].type || node.label !== rows[0].label) {
      errors.push({ nodeId, reason: 'node_identity_changed', expected: { type: rows[0].type, label: rows[0].label }, actual: { type: node.type, label: node.label } });
      continue;
    }
    const refs = new Set([...collectSectionRefs(node.metadata), ...collectSectionRefs(node.provenance)].map((ref) => ref.sectionKey));
    for (const row of rows) {
      if (!refs.has(row.oldSectionKey)) errors.push({ nodeId, label: node.label, oldSectionKey: row.oldSectionKey, reason: 'obsolete_ref_missing_or_changed' });
    }
  }
  if (errors.length) {
    throw new Error(`live_graph_preflight_failed: ${JSON.stringify(errors.slice(0, 20))}`);
  }
}

async function loadTargetSections(session, projectId, rows) {
  const sectionKeys = [...new Set(rows.map((row) => row.candidateNewSectionKey).filter(Boolean))];
  const result = await session.run(
    `
    MATCH (s:Entity {projectId: $projectId, type: 'bible_section'})
    WHERE s.label STARTS WITH $prefix
      AND s.metadata CONTAINS $sourceId
    RETURN s.id AS id, s.label AS label, s.metadata AS metadata
    `,
    { projectId, prefix: `${SOURCE_ID}::`, sourceId: SOURCE_ID },
  );
  const sections = new Map();
  for (const record of result.records) {
    const metadata = safeJson(record.get('metadata'));
    if (sectionKeys.includes(String(metadata.sectionKey ?? ''))) {
      sections.set(String(metadata.sectionKey), {
        id: record.get('id'),
        label: record.get('label'),
        metadata,
      });
    }
  }
  const missing = sectionKeys.filter((key) => !sections.has(key));
  if (missing.length) throw new Error(`missing_target_sections: ${missing.join(', ')}`);
  return sections;
}

function incidentEdgesForNode(edges, nodeId) {
  return edges
    .filter((edge) => edge.fromId === nodeId || edge.toId === nodeId)
    .map((edge) => ({
      id: edge.id,
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      direction: edge.fromId === nodeId ? 'out' : 'in',
      weight: edge.weight,
      metadata: edge.metadata,
      provenance: edge.provenance,
    }));
}

function activeSectionKeyForRow(row) {
  return row.status === 'migrabile' && row.candidateNewSectionKey ? row.candidateNewSectionKey : null;
}

function transformRefs(value, mapping, obsoleteKeys) {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => transformRefs(item, mapping, obsoleteKeys))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (['sectionKey', 'sourceSectionKey'].includes(key) && typeof nested === 'string') {
        if (mapping.has(nested)) out[key] = mapping.get(nested);
        else if (obsoleteKeys.has(nested)) return undefined;
        else out[key] = nested;
        continue;
      }
      if (key === 'previousSectionKey') {
        out[key] = nested;
        continue;
      }
      const transformed = transformRefs(nested, mapping, obsoleteKeys);
      if (transformed !== undefined) out[key] = transformed;
    }
    return out;
  }
  return value;
}

function buildMigrationPatch(node, rows) {
  const mapping = new Map(rows.map((row) => [row.oldSectionKey, activeSectionKeyForRow(row)]).filter((entry) => entry[1]));
  const obsoleteKeys = new Set(rows.map((row) => row.oldSectionKey));
  const nextMetadata = transformRefs(node.metadata, mapping, obsoleteKeys) ?? {};
  const nextProvenance = transformRefs(node.provenance, mapping, obsoleteKeys) ?? {};
  const auditEntry = {
    source: 'apply_obsolete_bible_canon_plan',
    sourceId: SOURCE_ID,
    migratedAt: new Date().toISOString(),
    previousEvidenceRefs: rows.map((row) => ({
      oldSectionKey: row.oldSectionKey,
      newSectionKey: row.candidateNewSectionKey,
      status: row.status,
      criterion: row.criterion,
      score: row.score,
    })),
  };
  const previousAudit = Array.isArray(nextMetadata.auditMigration) ? nextMetadata.auditMigration : [];
  nextMetadata.auditMigration = [...previousAudit, auditEntry];
  nextMetadata.sourceId = SOURCE_ID;
  nextMetadata.canonStatus = 'canonical';
  nextProvenance.source = 'apply_obsolete_bible_canon_plan';
  nextProvenance.sourceId = SOURCE_ID;
  return { metadata: nextMetadata, provenance: nextProvenance, mapping };
}

function uniqueEdges(edges) {
  const seen = new Set();
  const result = [];
  for (const edge of edges) {
    const key = stableKey([edge.fromId, edge.toId, edge.kind]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(edge);
    }
  }
  return result;
}

function buildPlan(classes, liveGraph, targetSections) {
  const safeMigrateEntries = [...classes.allMigrabile, ...classes.mixed];
  const safeMigrate = safeMigrateEntries.map((entry) => {
    const node = liveGraph.nodes.get(entry.nodeId);
    const patch = buildMigrationPatch(node, entry.rows);
    const targetKeys = [...new Set([...patch.mapping.values()])];
    return {
      nodeId: entry.nodeId,
      type: node.type,
      label: node.label,
      mode: entry.rows.every((row) => row.status === 'migrabile') ? 'all_migrabile' : 'mixed_migrabile_non',
      oldSectionKeys: entry.rows.map((row) => row.oldSectionKey),
      newSectionKeys: targetKeys,
      evidenceRefsRemoved: entry.rows.filter((row) => row.status !== 'migrabile').map((row) => row.oldSectionKey),
      patch,
    };
  });
  const edgeCreates = uniqueEdges(safeMigrate.flatMap((item) => item.newSectionKeys.map((sectionKey) => ({
    fromId: item.nodeId,
    toId: targetSections.get(sectionKey).id,
    kind: 'derived_from',
    weight: 1,
    metadata: { sourceId: SOURCE_ID, sectionKey, migrationRun: true },
    provenance: { source: 'apply_obsolete_bible_canon_plan', sourceId: SOURCE_ID, sectionKey },
  }))));
  const ambiguousHold = classes.ambiguous.map((entry) => {
    const node = liveGraph.nodes.get(entry.nodeId);
    return {
      nodeId: entry.nodeId,
      type: node.type,
      label: node.label,
      status: 'pending_ambiguous_resolution',
      rows: entry.rows.map((row) => ({
        oldSectionKey: row.oldSectionKey,
        candidateNewSectionKey: row.candidateNewSectionKey,
        criterion: row.criterion,
        score: row.score,
        reason: row.reason,
      })),
      incidentEdges: incidentEdgesForNode(liveGraph.edges, entry.nodeId),
    };
  });
  const deleteObsolete = classes.deleteObsolete.map((entry) => {
    const node = liveGraph.nodes.get(entry.nodeId);
    return {
      nodeId: entry.nodeId,
      type: node.type,
      label: node.label,
      reason: 'all_non_sostenuto',
      oldSectionKeys: entry.rows.map((row) => row.oldSectionKey),
      hasMigrabileRows: entry.rows.some((row) => row.status === 'migrabile'),
      hasAmbiguousRows: entry.rows.some((row) => row.status === 'ambiguo'),
      incidentEdges: incidentEdgesForNode(liveGraph.edges, entry.nodeId),
    };
  });
  return { safeMigrate, edgeCreates, ambiguousHold, deleteObsolete };
}

async function writeDryRunReport(plan, reportPath, beforeAudit) {
  const output = {
    generatedAt: new Date().toISOString(),
    sourceReport: reportPath,
    dryRun: true,
    beforeAudit,
    summary: {
      safeMigrate: plan.safeMigrate.length,
      deleteObsolete: plan.deleteObsolete.length,
      ambiguousHold: plan.ambiguousHold.length,
      edgeCreates: plan.edgeCreates.length,
      evidenceRefsRemoved: plan.safeMigrate.reduce((sum, item) => sum + item.evidenceRefsRemoved.length, 0),
    },
    safeMigrate: plan.safeMigrate.map((item) => ({
      nodeId: item.nodeId,
      type: item.type,
      label: item.label,
      mode: item.mode,
      oldSectionKeys: item.oldSectionKeys,
      newSectionKeys: item.newSectionKeys,
      evidenceRefsRemoved: item.evidenceRefsRemoved,
    })),
    deleteObsolete: plan.deleteObsolete,
    ambiguousHold: plan.ambiguousHold,
    edgeCreates: plan.edgeCreates,
  };
  const outDir = path.join(ROOT, 'dev-data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-obsolete-canon-apply-dry-run.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return outPath;
}

function serializeBackupNode(node) {
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    content: node.content,
    metadata: node.metadata,
    provenance: node.provenance,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

async function writeBackup(liveGraph, nodeIds) {
  const backup = {
    source: 'apply_obsolete_bible_canon_plan',
    sourceId: SOURCE_ID,
    createdAt: new Date().toISOString(),
    nodes: nodeIds.map((id) => serializeBackupNode(liveGraph.nodes.get(id))).filter(Boolean),
    relationships: liveGraph.edges,
    counts: { nodes: nodeIds.length, relationships: liveGraph.edges.length },
  };
  const backupDir = path.join(ROOT, 'dev-data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-canonical-obsolete-backup.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  const verified = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (verified.counts.nodes !== nodeIds.length || verified.counts.relationships !== liveGraph.edges.length) {
    throw new Error('backup_verification_failed');
  }
  return backupPath;
}

async function applyPlan(session, projectId, plan, liveGraph, nodeIds) {
  const backupPath = await writeBackup(liveGraph, nodeIds);
  const tx = session.beginTransaction();
  try {
    for (const item of plan.safeMigrate) {
      await tx.run(
        `
        MATCH (n:Entity {projectId: $projectId, id: $id})
        SET n.metadata = $metadata,
            n.provenance = $provenance,
            n.updatedAt = $updatedAt
        `,
        {
          projectId,
          id: item.nodeId,
          metadata: JSON.stringify(item.patch.metadata),
          provenance: JSON.stringify(item.patch.provenance),
          updatedAt: new Date().toISOString(),
        },
      );
    }
    for (const edge of plan.edgeCreates) {
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
          metadata: JSON.stringify(edge.metadata),
          provenance: JSON.stringify(edge.provenance),
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
      { projectId, deleteNodeIds: plan.deleteObsolete.map((item) => item.nodeId) },
    );
    await tx.commit();
    return { backupPath };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function globalAudit(session, projectId) {
  const one = async (cypher) => {
    const result = await session.run(cypher, { projectId });
    return result.records[0].get('count').toNumber();
  };
  const nonCanonical = await session.run(
    `
    MATCH (:Entity {projectId: $projectId})-[r:REL]->(:Entity {projectId: $projectId})
    WITH r.kind AS kind, count(r) AS count
    RETURN kind, count
    ORDER BY kind
    `,
    { projectId },
  );
  const technicalCounts = await session.run(
    `
    MATCH (n:Entity {projectId: $projectId})
    WHERE n.type IN ['bible_section', 'bible_outline']
    RETURN n.type AS type, count(n) AS count
    ORDER BY type
    `,
    { projectId },
  );
  return {
    nodes: await one('MATCH (n:Entity {projectId: $projectId}) RETURN count(n) AS count'),
    edges: await one('MATCH (:Entity {projectId: $projectId})-[r:REL]->(:Entity {projectId: $projectId}) RETURN count(r) AS count'),
    orphanNodes: await one('MATCH (n:Entity {projectId: $projectId}) WHERE NOT (n)--() RETURN count(n) AS count'),
    relatedToTotal: await one("MATCH (:Entity {projectId: $projectId})-[r:REL {kind:'related_to'}]->(:Entity {projectId: $projectId}) RETURN count(r) AS count"),
    nonRelPhysicalEdges: await one("MATCH (:Entity {projectId: $projectId})-[r]->(:Entity {projectId: $projectId}) WHERE type(r) <> 'REL' RETURN count(r) AS count"),
    edgeKinds: nonCanonical.records.map((record) => ({ kind: record.get('kind'), count: record.get('count').toNumber() })),
    technicalCounts: technicalCounts.records.map((record) => ({ type: record.get('type'), count: record.get('count').toNumber() })),
  };
}

async function main() {
  loadEnv();
  const { apply, dryRun, reportPath } = parseArgs();
  const projectId = process.env.PROJECT_ID || 'romanzo-gabriele';
  const { rows, byNode, classes } = loadValidatedReport(reportPath);
  const nodeIds = [...byNode.keys()];
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const beforeAudit = await globalAudit(session, projectId);
    const liveGraph = await loadLiveGraph(session, projectId, nodeIds);
    if (liveGraph.nodes.size !== nodeIds.length) throw new Error(`live_node_count_mismatch: expected ${nodeIds.length}, got ${liveGraph.nodes.size}`);
    verifyLiveGraph(byNode, liveGraph.nodes);
    const targetSections = await loadTargetSections(session, projectId, rows);
    const plan = buildPlan(classes, liveGraph, targetSections);
    assertEqual('dry_safe_migrate', plan.safeMigrate.length, EXPECTED.allMigrabileNodes + EXPECTED.mixedNodes);
    assertEqual('dry_delete_candidates', plan.deleteObsolete.length, EXPECTED.deleteCandidates);
    assertEqual('dry_ambiguous_hold', plan.ambiguousHold.length, EXPECTED.ambiguousNodes);
    const dryRunReportPath = await writeDryRunReport(plan, reportPath, beforeAudit);
    const summary = {
      ok: true,
      dryRun,
      sourceReport: reportPath,
      dryRunReportPath,
      beforeAudit,
      plan: {
        safeMigrate: plan.safeMigrate.length,
        deleteObsolete: plan.deleteObsolete.length,
        ambiguousHold: plan.ambiguousHold.length,
        edgeCreates: plan.edgeCreates.length,
        evidenceRefsRemoved: plan.safeMigrate.reduce((sum, item) => sum + item.evidenceRefsRemoved.length, 0),
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
