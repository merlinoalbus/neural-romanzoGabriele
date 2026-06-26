import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';
const EXPECTED_CANDIDATES = 10295;

const DISPOSITIONS = {
  COMMIT: 'A_committed_new_canonical_candidate',
  MERGE: 'B_merged_into_existing_canonical_candidate',
  REJECT: 'C_rejected_false_positive_candidate',
  SUPERSEDED: 'D_superseded_by_section_or_better_candidate',
  CONFLICT: 'E_conflict_requires_author_resolution',
};

function loadEnv() {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
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

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalizeText(value).split(' ').filter((token) => token.length > 1);
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) throw new Error(`preflight_count_mismatch:${label}: expected ${expected}, got ${actual}`);
}

function candidatePayload(node) {
  return node.metadata.candidate && typeof node.metadata.candidate === 'object' ? node.metadata.candidate : {};
}

function candidateMeta(node) {
  const candidate = candidatePayload(node);
  return candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {};
}

function candidateEvidence(node) {
  const candidate = candidatePayload(node);
  return candidate.evidence && typeof candidate.evidence === 'object' ? candidate.evidence : {};
}

function titleOnly(content, sectionKey, heading) {
  const normalized = normalizeText(content);
  return normalized === normalizeText(`${sectionKey} ${heading}`)
    || normalized === normalizeText(heading);
}

function genericLabel(label) {
  const normalized = normalizeText(label);
  if (/\b(claim|timeline event|knowledge state|motif|artifact|power|secret|revelation|narrative constraint|character wound|faction)\s+\d+$/.test(normalized)) return true;
  return [
    'relazioni chiave',
    'linguaggio e voce',
    'aspetto',
    'personalita',
    'funzione narrativa',
    'ruolo funzionale',
    'descrizione ruolo',
    'nota operativa',
    'controlli operativi',
    'verifiche crociate',
  ].includes(normalized);
}

function hasTypeFalsePositive(targetType, pathText, heading, content) {
  const haystack = normalizeText([pathText, heading, content].join(' '));
  if (targetType === 'location' && /personaggi|signora|ragazzina|prof|dott|allenatore|oculista/.test(haystack)) return true;
  if (targetType === 'knowledge_state' && !/\b(sa|sanno|sapere|conosce|conoscono|ignora|memoria|consapevole|ricorda|scopre)\b/.test(haystack)) return true;
  if (targetType === 'timeline_event' && /controllo cronologia obbligatorio|vietato utilizzare timeline alternative/.test(haystack)) return true;
  if (targetType === 'artifact' && !/\b(oggetto|artefatto|reliquia|occhiali|anello|spada|piuma|laptop|telefono|diario|microfono|foulard|ciondolo)\b/.test(haystack)) return true;
  if (targetType === 'power' && !/\b(potere|poteri|dono|abilita|xenoglossia|telepatia|guarigione|luce|ali)\b/.test(haystack)) return true;
  if (targetType === 'secret' && !/\b(segreto|nasconde|nascosto|occulta|custode)\b/.test(haystack)) return true;
  return false;
}

function isSectionTimelineCandidate(item) {
  return item.granularity === 'section'
    && item.targetType === 'timeline_event'
    && /^4\.[1-4]\.\d+$/.test(item.sectionKey)
    && /^(PROLOGO|CAP\.|EPILOGO)/i.test(item.heading);
}

function isSubstantiveSection(item) {
  return item.granularity === 'section'
    && !item.titleOnly
    && !item.genericLabel
    && !item.typeFalsePositive
    && item.wordCount >= 20;
}

function canonicalKey(type, label) {
  return `${type}::${normalizeText(label)}`;
}

function contentKey(type, content) {
  return `${type}::${normalizeText(content)}`;
}

function scoreCanonicalOverlap(content, canonicalNodes) {
  const candidateTokens = new Set(tokens(content).filter((token) => token.length > 3));
  if (!candidateTokens.size) return null;
  let best = null;
  for (const node of canonicalNodes) {
    if (node.type === 'bible_section' || node.type === 'bible_outline') continue;
    const nodeTokens = new Set(tokens(`${node.label} ${node.content}`).filter((token) => token.length > 3));
    if (!nodeTokens.size) continue;
    let overlap = 0;
    for (const token of candidateTokens) if (nodeTokens.has(token)) overlap++;
    const score = overlap / Math.min(candidateTokens.size, nodeTokens.size);
    if (!best || score > best.score) best = { id: node.id, type: node.type, label: node.label, score };
  }
  return best;
}

async function loadCandidates(session, projectId) {
  const result = await session.run(
    `
    MATCH (c:Entity {projectId: $projectId, type: 'bible_candidate'})
    WHERE c.metadata CONTAINS '"sourceId"' AND c.metadata CONTAINS $sourceId
    RETURN c.id AS id, c.label AS label, c.content AS content,
           c.metadata AS metadata, c.provenance AS provenance,
           c.createdAt AS createdAt, c.updatedAt AS updatedAt
    `,
    { projectId, sourceId: SOURCE_ID },
  );
  return result.records.map((record) => ({
    id: record.get('id'),
    label: record.get('label'),
    content: String(record.get('content') ?? ''),
    metadata: safeJson(record.get('metadata')),
    provenance: safeJson(record.get('provenance')),
    createdAt: String(record.get('createdAt') ?? ''),
    updatedAt: String(record.get('updatedAt') ?? ''),
  }));
}

async function loadCanonicalNodes(session, projectId) {
  const result = await session.run(
    `
    MATCH (n:Entity {projectId: $projectId})
    WHERE n.metadata CONTAINS '"canonStatus":"canonical"' OR n.metadata CONTAINS '"canonStatus": "canonical"'
    RETURN n.id AS id, n.type AS type, n.label AS label, n.content AS content,
           n.metadata AS metadata, n.provenance AS provenance
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

function buildItems(candidateNodes, canonicalNodes) {
  const canonicalLabels = new Map(canonicalNodes.map((node) => [canonicalKey(node.type, node.label), node]));
  const canonicalContents = new Map(canonicalNodes.map((node) => [contentKey(node.type, node.content), node]));
  const contentGroups = new Map();

  const items = candidateNodes.map((node) => {
    const candidate = candidatePayload(node);
    const metadata = candidateMeta(node);
    const evidence = candidateEvidence(node);
    const targetType = String(node.metadata.targetType ?? candidate.targetType ?? 'unknown');
    const label = String(candidate.label ?? node.label);
    const content = String(candidate.content ?? '');
    const heading = String(metadata.extractedHeading ?? label);
    const pathItems = Array.isArray(metadata.extractedFromPath) ? metadata.extractedFromPath.map(String) : [];
    const pathText = pathItems.join(' / ');
    const item = {
      nodeId: node.id,
      candidateId: String(candidate.candidateId ?? node.label),
      status: String(node.metadata.status ?? 'pending'),
      canonStatus: String(node.metadata.canonStatus ?? 'proposal'),
      candidateKind: String(node.metadata.candidateKind ?? candidate.candidateKind ?? 'unknown'),
      targetType,
      label,
      content,
      sectionKey: String(evidence.sectionKey ?? ''),
      heading,
      path: pathItems,
      granularity: String(metadata.granularity ?? 'unknown'),
      extractionRule: String(metadata.extractionRule ?? ''),
      wordCount: tokens(content).length,
      titleOnly: titleOnly(content, evidence.sectionKey, heading),
      genericLabel: genericLabel(label),
      typeFalsePositive: hasTypeFalsePositive(targetType, pathText, heading, content),
      exactCanonicalLabel: canonicalLabels.get(canonicalKey(targetType, label)) ?? null,
      exactCanonicalContent: canonicalContents.get(contentKey(targetType, content)) ?? null,
      bestCanonicalOverlap: null,
    };
    const key = normalizeText(content);
    if (key) {
      if (!contentGroups.has(key)) contentGroups.set(key, []);
      contentGroups.get(key).push(item);
    }
    return item;
  });

  for (const item of items) item.bestCanonicalOverlap = scoreCanonicalOverlap(item.content, canonicalNodes);
  for (const group of contentGroups.values()) {
    if (group.length <= 1) continue;
    const types = new Set(group.map((item) => item.targetType));
    for (const item of group) {
      item.duplicateGroupSize = group.length;
      item.duplicateTargetTypes = [...types].sort();
    }
  }
  return items;
}

function classifyItem(item) {
  if (item.status !== 'pending') {
    return { disposition: DISPOSITIONS.SUPERSEDED, reason: 'already_non_pending_before_classification' };
  }
  if (item.candidateKind !== 'node') {
    return { disposition: DISPOSITIONS.CONFLICT, reason: 'non_node_candidate_requires_manual_policy' };
  }
  if (!item.sectionKey) {
    return { disposition: DISPOSITIONS.CONFLICT, reason: 'missing_evidence_section_key' };
  }
  if (item.exactCanonicalLabel) {
    return {
      disposition: DISPOSITIONS.MERGE,
      reason: 'same_type_label_existing_canonical',
      target: { id: item.exactCanonicalLabel.id, type: item.exactCanonicalLabel.type, label: item.exactCanonicalLabel.label },
    };
  }
  if (item.exactCanonicalContent) {
    return {
      disposition: DISPOSITIONS.MERGE,
      reason: 'same_type_content_existing_canonical',
      target: { id: item.exactCanonicalContent.id, type: item.exactCanonicalContent.type, label: item.exactCanonicalContent.label },
    };
  }
  if (item.titleOnly) {
    return { disposition: DISPOSITIONS.REJECT, reason: 'heading_or_title_only_not_atomic_concept' };
  }
  if ((item.duplicateGroupSize ?? 0) > 1 && item.duplicateTargetTypes?.length > 1) {
    return { disposition: DISPOSITIONS.CONFLICT, reason: 'same_content_multiple_target_types_requires_type_selection' };
  }
  if (item.typeFalsePositive) {
    return { disposition: DISPOSITIONS.CONFLICT, reason: 'target_type_false_positive_requires_retyping_or_rejection' };
  }
  if (item.bestCanonicalOverlap && item.bestCanonicalOverlap.score >= 0.82 && item.bestCanonicalOverlap.type === item.targetType) {
    return {
      disposition: DISPOSITIONS.CONFLICT,
      reason: 'high_semantic_overlap_requires_manual_merge_review',
      target: item.bestCanonicalOverlap,
    };
  }
  if (isSectionTimelineCandidate(item)) {
    return { disposition: DISPOSITIONS.COMMIT, reason: 'high_quality_timeline_section_candidate_requires_specialized_edges' };
  }
  if (isSubstantiveSection(item)) {
    return { disposition: DISPOSITIONS.COMMIT, reason: 'substantive_section_candidate_requires_targeted_commit_plan' };
  }
  if (item.granularity === 'atomic') {
    return {
      disposition: DISPOSITIONS.COMMIT,
      reason: item.genericLabel
        ? 'atomic_candidate_requires_canonical_label_generation'
        : 'atomic_candidate_potentially_committable_after_label_normalization',
    };
  }
  if (item.granularity === 'section') {
    return { disposition: DISPOSITIONS.COMMIT, reason: 'section_candidate_requires_targeted_commit_plan' };
  }
  return { disposition: DISPOSITIONS.CONFLICT, reason: 'unclassified_candidate_requires_manual_resolution' };
}

function summarize(classifications) {
  const pendingBeforeClassification = classifications.filter((entry) => entry.item.status === 'pending').length;
  const unresolvedAfterClassification = classifications.filter((entry) => entry.disposition === DISPOSITIONS.CONFLICT).length;
  const summary = {
    total: classifications.length,
    byDisposition: {},
    byReason: {},
    byTargetType: {},
    byGranularity: {},
    pendingBeforeClassification,
    unresolvedAfterClassification,
    conflicts: 0,
    classifiedReceipts: classifications.length - unresolvedAfterClassification,
  };
  for (const entry of classifications) {
    summary.byDisposition[entry.disposition] = (summary.byDisposition[entry.disposition] ?? 0) + 1;
    summary.byReason[entry.reason] = (summary.byReason[entry.reason] ?? 0) + 1;
    summary.byTargetType[entry.item.targetType] = (summary.byTargetType[entry.item.targetType] ?? 0) + 1;
    summary.byGranularity[entry.item.granularity] = (summary.byGranularity[entry.item.granularity] ?? 0) + 1;
    if (entry.disposition === DISPOSITIONS.CONFLICT) summary.conflicts++;
  }
  summary.byDisposition = Object.fromEntries(Object.entries(summary.byDisposition).sort());
  summary.byReason = Object.fromEntries(Object.entries(summary.byReason).sort());
  summary.byTargetType = Object.fromEntries(Object.entries(summary.byTargetType).sort());
  summary.byGranularity = Object.fromEntries(Object.entries(summary.byGranularity).sort());
  return summary;
}

function samplesBy(classifications, keyFn, limit = 10) {
  const out = {};
  for (const entry of classifications) {
    const key = keyFn(entry);
    if (!out[key]) out[key] = [];
    if (out[key].length < limit) {
      out[key].push({
        candidateId: entry.item.candidateId,
        targetType: entry.item.targetType,
        label: entry.item.label,
        sectionKey: entry.item.sectionKey,
        disposition: entry.disposition,
        reason: entry.reason,
        target: entry.target,
        content: entry.item.content.slice(0, 240),
      });
    }
  }
  return out;
}

function serializeClassification(entry) {
  return {
    candidateId: entry.item.candidateId,
    nodeId: entry.item.nodeId,
    disposition: entry.disposition,
    reason: entry.reason,
    target: entry.target,
    statusBefore: entry.item.status,
    canonStatusBefore: entry.item.canonStatus,
    candidateKind: entry.item.candidateKind,
    targetType: entry.item.targetType,
    label: entry.item.label,
    sectionKey: entry.item.sectionKey,
    heading: entry.item.heading,
    path: entry.item.path,
    granularity: entry.item.granularity,
    extractionRule: entry.item.extractionRule,
    wordCount: entry.item.wordCount,
    titleOnly: entry.item.titleOnly,
    genericLabel: entry.item.genericLabel,
    typeFalsePositive: entry.item.typeFalsePositive,
    duplicateGroupSize: entry.item.duplicateGroupSize ?? 1,
    duplicateTargetTypes: entry.item.duplicateTargetTypes ?? [entry.item.targetType],
    bestCanonicalOverlap: entry.item.bestCanonicalOverlap,
    content: entry.item.content,
  };
}

async function writeReport(report) {
  const outDir = path.join(ROOT, 'dev-data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-all-candidate-classification-dry-run.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

async function main() {
  loadEnv();
  const projectId = process.env.PROJECT_ID || 'romanzo-gabriele';
  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const beforeAudit = await globalAudit(session, projectId);
    const candidateNodes = await loadCandidates(session, projectId);
    assertEqual('candidate_count', candidateNodes.length, EXPECTED_CANDIDATES);
    for (const candidateNode of candidateNodes) {
      const evidence = candidateEvidence(candidateNode);
      if (evidence.sourceId !== SOURCE_ID) {
        throw new Error(`candidate_source_mismatch:${candidateNode.id}:${String(evidence.sourceId)}`);
      }
    }
    const canonicalNodes = await loadCanonicalNodes(session, projectId);
    const items = buildItems(candidateNodes, canonicalNodes);
    const classifications = items.map((item) => ({ item, ...classifyItem(item) }));
    const summary = summarize(classifications);
    assertEqual('classified_count', summary.total, EXPECTED_CANDIDATES);
    const report = {
      ok: true,
      readOnly: true,
      sourceId: SOURCE_ID,
      generatedAt: new Date().toISOString(),
      beforeAudit,
      summary,
      samplesByDisposition: samplesBy(classifications, (entry) => entry.disposition),
      samplesByReason: samplesBy(classifications, (entry) => entry.reason, 6),
      classifications: classifications.map(serializeClassification),
      conflicts: classifications
        .filter((entry) => entry.disposition === DISPOSITIONS.CONFLICT)
        .map(serializeClassification),
      nextSteps: [
        'Validare questa classificazione con galaxy-task-validator.',
        'Applicare prima C/D non canonici solo se motivazioni e campioni sono approvati.',
        'Gestire E come blocchi da risolvere: nessun finale finche restano E.',
        'Commit A/B solo con piani mirati che creano/aggiornano archi specializzati e zero related_to.',
      ],
    };
    const reportPath = await writeReport(report);
    console.log(JSON.stringify({ ok: true, readOnly: true, reportPath, summary }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
