import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';
const TECHNICAL_TYPES = new Set([
  'bible_section',
  'bible_outline',
  'bible_candidate',
  'bible_coverage_finding',
  'bible_mapping_batch',
]);
const GENERIC_HEADINGS = new Set([
  'aspetto',
  'aspetto adolescente',
  'aspetto manifestazione terrena',
  'evoluzione',
  'relazioni chiave',
  'relazioni chiave:',
  'dinamiche emotive complesse',
  'dinamiche emotive complesse:',
  'personalita iniziale',
  'passato',
  'futuro post romanzo',
  'valori',
  'punti di rottura',
  'nota operativa',
  'sviluppo',
  'presenza nella sinossi',
  'manifestazione esemplificativa',
  'impatto sull evoluzione',
]);

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

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizedTokens(value) {
  return new Set(normalizeText(value).split(/\s+/).filter((token) => token.length > 2));
}

function jaccard(left, right) {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '').replace(/\r\n/g, '\n').trim()).digest('hex');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

function compact(value, length = 220) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > length ? `${normalized.slice(0, length - 3).trim()}...` : normalized;
}

function sectionFromNode(node) {
  const metadata = safeJson(node.metadata);
  return {
    id: node.id,
    key: String(metadata.sectionKey ?? ''),
    label: node.label,
    heading: String(metadata.heading ?? ''),
    path: safeArray(metadata.path).map(String),
    content: String(node.content ?? ''),
    contentHash: String(metadata.contentHash ?? sha256(node.content ?? '')),
  };
}

function branchSignature(section) {
  const normalizedPath = section.path.map(normalizeText).filter(Boolean);
  const withoutSelf = normalizedPath.slice(0, -1);
  return withoutSelf.slice(-3).join(' / ');
}

function isChronologySection(section) {
  const pathText = normalizeText(section.path.join(' '));
  const headingText = normalizeText(section.heading);
  return pathText.includes('cronologia dettagliata degli eventi')
    || /^capitolo\s+\d+/.test(headingText)
    || /^cap\s+\d+/.test(headingText)
    || headingText.startsWith('prologo')
    || headingText.startsWith('epilogo');
}

function chronologyTitle(heading) {
  return normalizeText(heading)
    .replace(/^capitolo\s+\d+(?:\.\d+)?\s+/, '')
    .replace(/^cap\s+\d+(?:\.\d+)?\s+/, '')
    .replace(/\b\d{1,2}\s+\d{1,2}\s+\d{4}\b/g, '')
    .replace(/\b\d{1,2}\s+\d{4}\b/g, '')
    .replace(/\bmichele\b/g, 'michael')
    .replace(/\s+/g, ' ')
    .trim();
}

function findChronologyMatch(oldSection, newSections) {
  if (!oldSection || !isChronologySection(oldSection)) return null;
  const oldTitle = chronologyTitle(oldSection.heading);
  if (!oldTitle || oldTitle === 'epilogo') return null;
  const candidates = newSections
    .filter((section) => isChronologySection(section))
    .map((section) => {
      const newTitle = chronologyTitle(section.heading);
      const titleScore = oldTitle === newTitle ? 1 : jaccard(oldTitle, newTitle);
      const contentScore = jaccard(oldSection.content.slice(0, 1200), section.content.slice(0, 1200));
      return { section, titleScore, contentScore, score: (titleScore * 0.8) + (contentScore * 0.2) };
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best && best.titleScore >= 0.82 && best.score >= 0.78) {
    return {
      section: best.section,
      criterion: 'chronology_title_branch',
      score: Number(best.score.toFixed(4)),
      reason: 'Voce di cronologia riconciliata per titolo normalizzato e ramo cronologia.',
    };
  }
  return null;
}

function pathOverlap(left, right) {
  return jaccard(left.path.join(' '), right.path.join(' '));
}

function isGenericHeading(heading) {
  return GENERIC_HEADINGS.has(normalizeText(heading));
}

function findBestSectionMatch(oldSection, newSections, newByHash, newByHeading) {
  if (!oldSection) return null;
  const hashMatch = newByHash.get(oldSection.contentHash);
  if (hashMatch) {
    return {
      section: hashMatch,
      criterion: 'contentHash',
      score: 1,
      reason: 'Content hash identico tra vecchia e nuova sezione.',
    };
  }

  const chronologyMatch = findChronologyMatch(oldSection, newSections);
  if (chronologyMatch) return chronologyMatch;

  const headingMatches = newByHeading.get(normalizeText(oldSection.heading)) ?? [];
  const scoredHeadingMatches = headingMatches.map((section) => ({
    section,
    contentScore: jaccard(oldSection.content, section.content),
    pathScore: pathOverlap(oldSection, section),
  })).sort((a, b) => (b.contentScore + b.pathScore) - (a.contentScore + a.pathScore));
  const bestHeading = scoredHeadingMatches[0];
  if (bestHeading && !isGenericHeading(oldSection.heading) && bestHeading.contentScore >= 0.82 && bestHeading.pathScore >= 0.35) {
    return {
      section: bestHeading.section,
      criterion: 'heading_path_content',
      score: Number(((bestHeading.contentScore * 0.75) + (bestHeading.pathScore * 0.25)).toFixed(4)),
      reason: 'Titolo non generico, ramo coerente e contenuto molto simile.',
    };
  }

  let best = null;
  const oldComparable = `${oldSection.heading}\n${branchSignature(oldSection)}\n${oldSection.content.slice(0, 1800)}`;
  for (const section of newSections) {
    const contentScore = jaccard(oldComparable, `${section.heading}\n${branchSignature(section)}\n${section.content.slice(0, 1800)}`);
    const pathScore = pathOverlap(oldSection, section);
    const score = (contentScore * 0.8) + (pathScore * 0.2);
    if (!best || score > best.score) best = { section, score, contentScore, pathScore };
  }
  if (best && best.score >= 0.74 && best.pathScore >= 0.25) {
    return {
      section: best.section,
      criterion: 'semantic_section_high',
      score: Number(best.score.toFixed(4)),
      reason: 'Similarita semantico-lessicale alta con ramo coerente.',
    };
  }
  return null;
}

function findTextEvidenceMatch(node, newSections, pendingCandidates) {
  const haystack = `${node.label}\n${node.content}`.slice(0, 1800);
  let bestSection = null;
  for (const section of newSections) {
    const score = jaccard(haystack, `${section.heading}\n${section.content.slice(0, 2200)}`);
    if (!bestSection || score > bestSection.score) bestSection = { section, score };
  }
  let bestCandidate = null;
  for (const candidate of pendingCandidates) {
    const candidateText = `${candidate.label}\n${candidate.content}\n${candidate.targetType}`;
    const score = jaccard(haystack, candidateText);
    if (!bestCandidate || score > bestCandidate.score) bestCandidate = { candidate, score };
  }
  const sectionStrong = bestSection && bestSection.score >= 0.58;
  const candidateStrong = bestCandidate && bestCandidate.score >= 0.68;
  if (candidateStrong && (!sectionStrong || bestCandidate.score >= bestSection.score)) {
    return {
      sectionKey: bestCandidate.candidate.sectionKey,
      candidateId: bestCandidate.candidate.candidateId,
      criterion: 'pending_candidate_text_strong',
      score: Number(bestCandidate.score.toFixed(4)),
      reason: 'Testo del canonico ritrovato in un candidato pending aggiornato.',
    };
  }
  if (sectionStrong) {
    return {
      sectionKey: bestSection.section.key,
      criterion: 'section_text_strong',
      score: Number(bestSection.score.toFixed(4)),
      reason: 'Testo del canonico ritrovato direttamente in una nuova sezione.',
    };
  }
  return null;
}

async function main() {
  loadEnv();
  const projectId = process.env.PROJECT_ID || 'romanzo-gabriele';
  const backupPath = process.argv[2] || fs.readdirSync(path.join(ROOT, 'dev-data', 'backups'))
    .filter((name) => name.endsWith(`${SOURCE_ID}-technical-corpus-backup.json`))
    .sort()
    .map((name) => path.join(ROOT, 'dev-data', 'backups', name))
    .at(-1);
  if (!backupPath) throw new Error('missing_backup: pass backup path or create a technical corpus backup first');

  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  const oldSections = backup.nodes
    .filter((node) => node.type === 'bible_section')
    .map(sectionFromNode);
  const oldByKey = new Map(oldSections.map((section) => [section.key, section]));

  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const sectionResult = await session.run(
      `
      MATCH (s:Entity {projectId: $projectId, type: 'bible_section'})
      WHERE s.label STARTS WITH $prefix
      RETURN s.id AS id, s.label AS label, s.content AS content, s.metadata AS metadata
      ORDER BY s.label
      `,
      { projectId, prefix: `${SOURCE_ID}::` },
    );
    const newSections = sectionResult.records.map((record) => sectionFromNode({
      id: record.get('id'),
      label: record.get('label'),
      content: record.get('content'),
      metadata: record.get('metadata'),
    }));
    const newSectionKeys = new Set(newSections.map((section) => section.key));
    const newByHash = new Map(newSections.map((section) => [section.contentHash, section]));
    const newByHeading = new Map();
    for (const section of newSections) {
      const key = normalizeText(section.heading);
      if (!newByHeading.has(key)) newByHeading.set(key, []);
      newByHeading.get(key).push(section);
    }

    const pendingResult = await session.run(
      `
      MATCH (c:Entity {projectId: $projectId, type: 'bible_candidate'})
      WHERE c.metadata CONTAINS $sourceId
      RETURN c.id AS id, c.label AS label, c.content AS content, c.metadata AS metadata
      `,
      { projectId, sourceId: SOURCE_ID },
    );
    const pendingCandidates = pendingResult.records.map((record) => {
      const metadata = safeJson(record.get('metadata'));
      const candidate = asObject(metadata.candidate);
      const evidence = asObject(candidate.evidence ?? metadata.evidence);
      return {
        id: record.get('id'),
        candidateId: String(candidate.candidateId ?? record.get('label')),
        targetType: String(candidate.targetType ?? metadata.targetType ?? ''),
        label: String(candidate.label ?? record.get('label')),
        content: String(candidate.content ?? record.get('content') ?? ''),
        sectionKey: String(evidence.sectionKey ?? ''),
      };
    }).filter((candidate) => candidate.sectionKey && newSectionKeys.has(candidate.sectionKey));

    const canonicalResult = await session.run(
      `
      MATCH (n:Entity {projectId: $projectId})
      WHERE NOT n.type IN $technicalTypes
        AND (n.metadata CONTAINS $sourceId OR n.provenance CONTAINS $sourceId)
      OPTIONAL MATCH (n)-[r:REL {kind: 'derived_from'}]-(s:Entity {projectId: $projectId, type: 'bible_section'})
      RETURN n.id AS id,
             n.type AS type,
             n.label AS label,
             n.content AS content,
             n.metadata AS metadata,
             n.provenance AS provenance,
             collect({sectionKey: s.metadata, sectionLabel: s.label, edgeId: r.id}) AS derivedFrom
      ORDER BY n.type, n.label
      `,
      { projectId, sourceId: SOURCE_ID, technicalTypes: [...TECHNICAL_TYPES] },
    );

    const rows = [];
    for (const record of canonicalResult.records) {
      const node = {
        nodeId: record.get('id'),
        type: record.get('type'),
        label: record.get('label'),
        content: String(record.get('content') ?? ''),
        metadata: safeJson(record.get('metadata')),
        provenance: safeJson(record.get('provenance')),
      };
      const refs = [
        ...collectSectionRefs(node.metadata),
        ...collectSectionRefs(node.provenance),
      ];
      for (const derived of record.get('derivedFrom') ?? []) {
        const sectionMetadata = safeJson(derived.sectionKey);
        if (sectionMetadata.sectionKey) refs.push({ sectionKey: String(sectionMetadata.sectionKey), path: 'derived_from' });
      }
      const uniqueOldKeys = [...new Set(refs.map((ref) => ref.sectionKey).filter((key) => key && !newSectionKeys.has(key)))];
      if (!uniqueOldKeys.length) continue;
      for (const oldKey of uniqueOldKeys) {
        const oldSection = oldByKey.get(oldKey);
        const sectionMatch = findBestSectionMatch(oldSection, newSections, newByHash, newByHeading);
        const textMatch = findTextEvidenceMatch(node, newSections, pendingCandidates);
        let status = 'non_sostenuto';
        let candidateNewSectionKey = null;
        let candidateId = null;
        let criterion = 'no_new_evidence';
        let score = 0;
        let reason = oldSection ? 'Nessuna evidenza nuova sufficientemente forte.' : 'La sectionKey obsoleta non esiste nel backup sezioni tecniche.';

        if (sectionMatch && (!isGenericHeading(oldSection?.heading) || sectionMatch.criterion === 'contentHash')) {
          status = 'migrabile';
          candidateNewSectionKey = sectionMatch.section.key;
          criterion = sectionMatch.criterion;
          score = sectionMatch.score;
          reason = sectionMatch.reason;
        } else if (textMatch) {
          status = 'migrabile';
          candidateNewSectionKey = textMatch.sectionKey;
          candidateId = textMatch.candidateId ?? null;
          criterion = textMatch.criterion;
          score = textMatch.score;
          reason = textMatch.reason;
        } else if (sectionMatch) {
          status = 'ambiguo';
          candidateNewSectionKey = sectionMatch.section.key;
          criterion = `${sectionMatch.criterion}_ambiguous`;
          score = sectionMatch.score;
          reason = `Match possibile ma non sicuro: heading generico o contesto insufficiente. ${sectionMatch.reason}`;
        }

        rows.push({
          nodeId: node.nodeId,
          type: node.type,
          label: node.label,
          oldSectionKey: oldKey,
          oldHeading: oldSection?.heading ?? null,
          candidateNewSectionKey,
          candidateNewHeading: candidateNewSectionKey ? newSections.find((section) => section.key === candidateNewSectionKey)?.heading ?? null : null,
          candidateId,
          criterion,
          score,
          status,
          reason,
          evidencePaths: refs.filter((ref) => ref.sectionKey === oldKey).map((ref) => ref.path).sort(),
          nodeContentSample: compact(node.content),
        });
      }
    }

    const summary = {
      sourceId: SOURCE_ID,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      backupPath,
      oldSectionCount: oldSections.length,
      newSectionCount: newSections.length,
      pendingCandidateCount: pendingCandidates.length,
      canonicalNodesWithObsoleteRefs: new Set(rows.map((row) => row.nodeId)).size,
      obsoleteRefRows: rows.length,
      byStatus: rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
      byTypeStatus: rows.reduce((acc, row) => {
        const key = `${row.type}:${row.status}`;
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    };
    const report = { summary, rows };
    const reportDir = path.join(ROOT, 'dev-data', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-obsolete-canon-analysis.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, ...summary, reportPath, samples: rows.slice(0, 20) }, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
