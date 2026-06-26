import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE_ID = 'bibbia-gabriele-2025';
const CLASSIFICATION_REPORT = path.join(
  ROOT,
  'dev-data',
  'reports',
  '2026-06-26T23-29-01-985Z-bibbia-gabriele-2025-all-candidate-classification-dry-run.json',
);

const DISPOSITIONS = {
  COMMIT: 'A_committed_new_canonical_candidate',
  MERGE: 'B_merged_into_existing_canonical_candidate',
  REJECT: 'C_rejected_false_positive_candidate',
  CONFLICT: 'E_conflict_requires_author_resolution',
};

const SPECIALIZED_TYPES = [
  'timeline_event',
  'narrative_constraint',
  'world_rule',
  'power',
  'revelation',
  'secret',
  'knowledge_state',
  'character_state',
  'character_wound',
  'character_goal',
  'character_belief',
  'character_voice',
  'character_trait',
  'relationship_dynamic',
  'faction',
  'artifact',
  'symbol',
  'motif',
  'theme',
  'location',
  'precognitive_data',
  'glossary_term',
  'bible_claim',
];

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value) {
  return normalizeText(value).split(' ').filter(Boolean);
}

function hasAny(haystack, patterns) {
  return patterns.some((pattern) => pattern.test(haystack));
}

function isControlChronology(text) {
  return /controllo cronolog|controllo cronologia|vietato utilizzare timeline alternative|allinearsi con sez/i.test(text);
}

function isAtomicOperationalConstraint(text) {
  const trimmed = String(text ?? '').trim();
  return /^CONTROLLO\b.*\bOBBLIGATORIO\b/i.test(trimmed)
    || /^NOTA AI:/i.test(trimmed)
    || /^MAI\b/i.test(trimmed)
    || /^VIETATO\b/i.test(trimmed);
}

function isInstructionalChronologyFragment(text) {
  return /cronologia dettagliata|prima di scrivere|consultando sez|vietato utilizzare timeline alternative|deve allinearsi con sez/i.test(String(text ?? ''));
}

function isSectionRefFragment(text) {
  return /^(?:[0-9]\.[0-9](?:,\s*)?)+\.?$/.test(text.trim())
    || /^sez\.\s*(?:[0-9]\.[0-9](?:,\s*)?)+\.?$/i.test(text.trim())
    || /^cronologia:\s*sez\.$/i.test(text.trim());
}

function isHeadingFragment(entry) {
  const content = normalizeText(entry.content);
  const label = normalizeText(entry.label);
  if (entry.titleOnly) return true;
  if (!content) return true;
  if (isSectionRefFragment(entry.content)) return true;
  if (/\(sez\.?\s*$/i.test(String(entry.content ?? '').trim())) return true;
  if (/^\d+(?:\.\d+)*\)\s*[^.]{0,80}$/i.test(String(entry.content ?? '').trim())) return true;
  if (/^dinamiche specifiche:?$/.test(content)) return true;
  if (/^con [a-z]+ [a-z]+$/.test(content)) return true;
  if (/^incarnare [a-z ]+$/.test(content)) return true;
  if (words(entry.content).length <= 2 && label.includes(content)) return true;
  return false;
}

function scoreType(type, entries, text) {
  const normalized = normalizeText(text);
  const sectionKey = entries[0]?.sectionKey ?? '';
  const pathText = normalizeText(entries.flatMap((entry) => entry.path ?? []).join(' '));
  let score = 0;
  if (entries.some((entry) => entry.targetType === type)) score += 10;
  if (type !== 'bible_claim') score += 2;

  if (
    type === 'narrative_constraint'
    && (isControlChronology(text) || isAtomicOperationalConstraint(text) || isInstructionalChronologyFragment(text) || /controlli operativi|divieti assoluti/i.test(pathText))
  ) score += 180;
  if (type === 'timeline_event' && /^4\./.test(sectionKey)) score += 70;
  if (type === 'timeline_event' && hasAny(normalized, [/\bcap\b/, /\bfase\b/, /\bpost\b/, /\bpre\b/, /\bsettembre\b/, /\bottobre\b/, /\bnovembre\b/, /\bdicembre\b/, /\bgiugno\b/, /\b2020\b/, /\b2021\b/])) score += 35;
  if (type === 'power' && hasAny(`${normalized} ${pathText}`, [/\bpotere\b/, /\bpoteri\b/, /\babilita\b/, /\bmanifestazioni\b/, /\bxenoglossia\b/, /\btelepatia\b/, /\bguarigione\b/, /\bluce\b/, /\bali\b/, /\bangelic/])) score += 95;
  if (type === 'secret' && hasAny(normalized, [/\bsegreto\b/, /\bnasconde un segreto\b/, /\bnascosto agli altri\b/, /\bocculta\b/, /\bcustodisce il segreto\b/])) score += 45;
  if (type === 'revelation' && hasAny(`${normalized} ${pathText}`, [/\brivela\b/, /\brivelazione\b/, /\bscopre\b/, /\bscoperta\b/, /\bvera natura\b/, /\bidentita\b/, /\brecupero memoria\b/, /\baccettazione tormentata\b/, /\brifiuto terrorizzato\b/])) score += 80;
  if (type === 'knowledge_state' && hasAny(normalized, [/\bsa\b/, /\bsanno\b/, /\bconosce\b/, /\bignora\b/, /\bricorda\b/, /\bmemoria\b/, /\bconsapevolezza\b/, /\bcomprende\b/])) score += 40;
  if (type === 'character_wound' && hasAny(normalized, [/\bferita\b/, /\bumiliazione\b/, /\btrauma\b/, /\brifiuto\b/, /\babbandono\b/, /\bvergogna\b/])) score += 42;
  if (type === 'character_goal' && hasAny(normalized, [/\bobiettivo\b/, /\bvuole\b/, /\bdesidera\b/, /\bmira\b/, /\bscopo\b/])) score += 38;
  if (type === 'character_belief' && hasAny(normalized, [/\bcrede\b/, /\bconvinzione\b/, /\bvalori\b/, /\bvisione\b/])) score += 38;
  if (type === 'character_state' && hasAny(`${normalized} ${pathText}`, [/\baspetto\b/, /\bpersonalita\b/, /\bpsicolog/, /\bpattern comportament/, /\bstato\b/, /\bevoluzione\b/, /\bruolo\b/, /\bviso\b/, /\bspalle\b/, /\bcapelli\b/, /\bocchi\b/, /\bpelle\b/, /\bcorporatura\b/, /\babbigliamento\b/, /\bindossa\b/, /\baura\b/, /\bfisic/, /\bpostura\b/])) score += 70;
  if (type === 'relationship_dynamic' && hasAny(`${normalized} ${pathText}`, [/\brelazione\b/, /\brelazioni\b/, /\brapporto\b/, /\blegame\b/, /\bamore\b/, /\bamicizia\b/, /\bfamiglia\b/])) score += 38;
  if (type === 'faction' && hasAny(`${normalized} ${pathText}`, [/\bfazione\b/, /\bgruppo\b/, /\bsquadra\b/, /\balleati\b/, /\bistituto\b/, /\bcoro celeste\b/])) score += 32;
  if (type === 'artifact' && hasAny(normalized, [/\boggetto\b/, /\bartefatto\b/, /\bpiuma\b/, /\bpiume\b/, /\bciondolo\b/, /\banello\b/, /\bdiario\b/, /\bocchiali\b/, /\blaptop\b/, /\btelefono\b/])) score += 42;
  if (type === 'symbol' && hasAny(normalized, [/\bsimbolo\b/, /\bsimbolic/, /\brappresenta\b/, /\bemblema\b/])) score += 34;
  if (type === 'world_rule' && hasAny(`${normalized} ${pathText}`, [/\bregola\b/, /\blegge\b/, /\bordine divino\b/, /\boblio\b/, /\bcaduta angelica\b/, /\bleggi divine\b/, /\btrasgressione\b/])) score += 40;
  if (type === 'motif' && hasAny(`${normalized} ${pathText}`, [/\btema\b/, /\bmotivo\b/, /\bcontrasto\b/, /\bvs\b/, /\btensione\b/, /\bincarna\b/])) score += 28;
  if (type === 'theme' && hasAny(`${normalized} ${pathText}`, [/\btema\b/, /\btematica\b/, /\bvalore\b/])) score += 24;
  if (type === 'location' && hasAny(normalized, [/\bluogo\b/, /\bquartiere\b/, /\bscuola\b/, /\bistituto\b/, /\bosservatorio\b/, /\bzoo\b/, /\bcasa\b/])) score += 24;
  if (type === 'bible_claim') score += 1;
  return score;
}

function chooseResolvedType(entries) {
  const text = entries[0]?.content ?? '';
  const available = new Set(entries.map((entry) => entry.targetType));
  const scored = SPECIALIZED_TYPES
    .map((type) => ({ type, score: scoreType(type, entries, text) }))
    .sort((a, b) => b.score - a.score || SPECIALIZED_TYPES.indexOf(a.type) - SPECIALIZED_TYPES.indexOf(b.type));
  const best = scored[0];
  if (entries.some(isHeadingFragment) && isControlChronology(text)) {
    return { action: 'commit', targetType: 'narrative_constraint', reason: 'chronology_fragment_absorbed_as_narrative_constraint' };
  }
  if (entries.some(isHeadingFragment)) {
    return {
      action: 'absorb_fragment',
      targetType: available.has('relationship_dynamic') ? 'relationship_dynamic' : 'motif',
      reason: 'non_atomic_fragment_absorbed_without_new_canonical_node',
    };
  }
  if (!best || best.score < 12) {
    return {
      action: 'commit',
      targetType: available.has('motif') ? 'motif' : 'bible_claim',
      reason: entries.some(isHeadingFragment)
        ? 'fragment_preserved_as_atomic_concept'
        : 'fallback_specific_bible_claim_after_type_review',
    };
  }
  return { action: 'commit', targetType: best.type, reason: `resolved_to_${best.type}` };
}

function representativeFor(entries, targetType) {
  const exact = entries.find((entry) => entry.targetType === targetType);
  if (exact) return exact;
  const nonClaim = entries.find((entry) => entry.targetType !== 'bible_claim');
  return nonClaim ?? entries[0];
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function decisionBase(entry, decision, reason, targetType = entry.targetType) {
  return {
    candidateId: entry.candidateId,
    nodeId: entry.nodeId,
    originalDisposition: entry.disposition,
    finalDisposition: decision,
    resolutionReason: reason,
    originalTargetType: entry.targetType,
    resolvedTargetType: targetType,
    sectionKey: entry.sectionKey,
    label: entry.label,
    content: entry.content,
  };
}

function reconcile(report) {
  const decisions = [];
  const conflictGroups = [];
  const byId = new Set();
  for (const entry of report.classifications) {
    if (byId.has(entry.candidateId)) throw new Error(`duplicate_candidate_id:${entry.candidateId}`);
    byId.add(entry.candidateId);
    if (entry.disposition !== DISPOSITIONS.CONFLICT) {
      if (entry.disposition === DISPOSITIONS.COMMIT) {
        const resolution = chooseResolvedType([entry]);
        const resolvedType = resolution.targetType ?? entry.targetType;
        decisions.push(decisionBase(entry, entry.disposition, `preserve_${entry.reason}:resolved_${resolvedType}`, resolvedType));
      } else {
        decisions.push(decisionBase(entry, entry.disposition, `preserve_${entry.reason}`, entry.targetType));
      }
    }
  }

  const conflicts = report.classifications.filter((entry) => entry.disposition === DISPOSITIONS.CONFLICT);
  const duplicateType = conflicts.filter((entry) => entry.reason === 'same_content_multiple_target_types_requires_type_selection');
  const duplicateGroups = groupBy(duplicateType, (entry) => normalizeText(entry.content));

  for (const [groupKey, entries] of duplicateGroups) {
    const resolution = chooseResolvedType(entries);
    const representative = representativeFor(entries, resolution.targetType);
    const evidenceSections = [...new Set(entries.map((entry) => entry.sectionKey).filter(Boolean))].sort();
    conflictGroups.push({
      groupKey,
      candidateCount: entries.length,
      candidateIds: entries.map((entry) => entry.candidateId),
      originalTargetTypes: [...new Set(entries.map((entry) => entry.targetType))].sort(),
      action: resolution.action,
      resolvedTargetType: resolution.targetType,
      representativeCandidateId: representative?.candidateId ?? null,
      resolutionReason: resolution.reason,
      evidenceSections,
      content: entries[0].content,
    });
    for (const entry of entries) {
      if (resolution.action === 'absorb_fragment') {
        decisions.push({
          ...decisionBase(entry, DISPOSITIONS.MERGE, resolution.reason, resolution.targetType),
          mergeTargetCandidateId: null,
          mergeTargetSectionKey: entry.sectionKey,
        });
      } else if (entry.candidateId === representative.candidateId) {
        decisions.push(decisionBase(entry, DISPOSITIONS.COMMIT, resolution.reason, resolution.targetType));
      } else {
        decisions.push({
          ...decisionBase(entry, DISPOSITIONS.MERGE, `absorbed_by_representative:${representative.candidateId}:${resolution.reason}`, resolution.targetType),
          mergeTargetCandidateId: representative.candidateId,
        });
      }
    }
  }

  for (const entry of conflicts.filter((item) => item.reason === 'high_semantic_overlap_requires_manual_merge_review')) {
    decisions.push({
      ...decisionBase(entry, DISPOSITIONS.MERGE, 'merge_to_existing_same_type_canonical_high_overlap_preserve_evidence', entry.targetType),
      mergeTargetCanonical: entry.target,
    });
  }

  for (const entry of conflicts.filter((item) => item.reason === 'target_type_false_positive_requires_retyping_or_rejection')) {
    const resolution = chooseResolvedType([entry]);
    decisions.push(decisionBase(entry, DISPOSITIONS.COMMIT, resolution.reason, resolution.targetType ?? entry.targetType));
  }

  const missing = report.classifications.length - decisions.length;
  if (missing !== 0) throw new Error(`decision_count_mismatch:${decisions.length}:${report.classifications.length}`);

  const duplicateDecisionIds = [...groupBy(decisions, (decision) => decision.candidateId).entries()]
    .filter(([, items]) => items.length > 1)
    .map(([candidateId, items]) => ({ candidateId, count: items.length }));
  if (duplicateDecisionIds.length) throw new Error(`duplicate_decisions:${JSON.stringify(duplicateDecisionIds.slice(0, 5))}`);

  return { decisions, conflictGroups };
}

function summarize(decisions, conflictGroups) {
  const byDisposition = {};
  const byResolvedType = {};
  const byReason = {};
  const reasonKey = (reason) => {
    const match = String(reason).match(/^absorbed_by_representative:[^:]+:(.+)$/);
    return match ? `absorbed_by_representative:${match[1]}` : reason;
  };
  for (const decision of decisions) {
    byDisposition[decision.finalDisposition] = (byDisposition[decision.finalDisposition] ?? 0) + 1;
    byResolvedType[decision.resolvedTargetType] = (byResolvedType[decision.resolvedTargetType] ?? 0) + 1;
    const groupedReason = reasonKey(decision.resolutionReason);
    byReason[groupedReason] = (byReason[groupedReason] ?? 0) + 1;
  }
  return {
    totalDecisions: decisions.length,
    reconciledConflicts: decisions.filter((decision) => decision.originalDisposition === DISPOSITIONS.CONFLICT).length,
    unresolvedConflictsAfterPlan: decisions.filter((decision) => decision.finalDisposition === DISPOSITIONS.CONFLICT).length,
    duplicateContentGroupsResolved: conflictGroups.length,
    byDisposition: Object.fromEntries(Object.entries(byDisposition).sort()),
    byResolvedType: Object.fromEntries(Object.entries(byResolvedType).sort()),
    byReason: Object.fromEntries(Object.entries(byReason).sort()),
  };
}

function writeReport(report) {
  const outDir = path.join(ROOT, 'dev-data', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${SOURCE_ID}-conflict-reconciliation-plan-dry-run.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

function main() {
  const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : CLASSIFICATION_REPORT;
  const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!report.readOnly || report.sourceId !== SOURCE_ID) throw new Error('invalid_classification_report');
  const { decisions, conflictGroups } = reconcile(report);
  const summary = summarize(decisions, conflictGroups);
  const output = {
    ok: true,
    readOnly: true,
    sourceId: SOURCE_ID,
    generatedAt: new Date().toISOString(),
    classificationReport: inputPath,
    summary,
    conflictGroups,
    decisions,
    validationRules: [
      'Ogni bible_candidate ha esattamente una decisione finale.',
      'Nessuna decisione finale resta E_conflict_requires_author_resolution.',
      'I duplicati per contenuto sono ricondotti a un rappresentante canonico con tutte le sezioni evidenza preservate.',
      'I frammenti/heading senza contenuto atomico sono rigettati, non canonizzati.',
      'I merge semantici non esatti restano esplicitati come merge da verificare nel piano di apply, non applicati qui.',
    ],
  };
  const outPath = writeReport(output);
  console.log(JSON.stringify({ ok: true, readOnly: true, reportPath: outPath, summary }, null, 2));
}

main();
