import { isCanonicalKind } from '../graph/ontology.js';
import { isNovelNodeType, type NovelNodeType } from './domain.js';

export const BIBLE_CANDIDATE_STATUSES = ['pending', 'committed', 'rejected'] as const;
export type BibleCandidateStatus = typeof BIBLE_CANDIDATE_STATUSES[number];

export const BIBLE_CANDIDATE_KINDS = ['node', 'edge'] as const;
export type BibleCandidateKind = typeof BIBLE_CANDIDATE_KINDS[number];

export const BIBLE_CANDIDATE_GRANULARITIES = ['section', 'atomic', 'both'] as const;
export type BibleCandidateGranularity = typeof BIBLE_CANDIDATE_GRANULARITIES[number];

export const BIBLE_CANDIDATE_FAMILIES = [
  'characters',
  'glossary',
  'knowledge_secrets',
  'objects_powers_factions',
  'plot',
  'relationships',
  'style',
  'symbols',
  'themes',
  'timeline',
  'worldbuilding',
] as const;
export type BibleCandidateFamily = typeof BIBLE_CANDIDATE_FAMILIES[number];

export const COMMITTABLE_BIBLE_NODE_TYPES = [
  'artifact',
  'bible_claim',
  'chapter',
  'character',
  'character_belief',
  'character_goal',
  'character_state',
  'character_trait',
  'character_voice',
  'character_wound',
  'conflict',
  'emotional_state',
  'entity_class',
  'faction',
  'foreshadowing',
  'glossary_term',
  'knowledge_state',
  'location',
  'motif',
  'mystery',
  'narrative_constraint',
  'plot_thread',
  'power',
  'precognitive_data',
  'prophecy',
  'relationship_dynamic',
  'revelation',
  'scene',
  'secret',
  'style_rule',
  'symbol',
  'theme',
  'timeline_event',
  'world_rule',
] as const satisfies readonly NovelNodeType[];

export const COMMITTABLE_BIBLE_NODE_TYPE_SET: ReadonlySet<string> = new Set(COMMITTABLE_BIBLE_NODE_TYPES);

export interface BibleCandidateEvidenceSpan {
  startChar?: number;
  endChar?: number;
  paragraphIndex?: number;
}

export interface BibleCandidateEvidence {
  sourceId: string;
  sectionKey: string;
  sectionLabel?: string;
  contentHash?: string;
  path?: string[];
  span?: BibleCandidateEvidenceSpan;
  textSnippet?: string;
}

export interface BibleCandidateEndpoint {
  type: NovelNodeType;
  label: string;
}

export interface BibleCandidate {
  candidateId: string;
  candidateKind: BibleCandidateKind;
  targetType?: NovelNodeType;
  label?: string;
  content?: string;
  relationKind?: string;
  from?: BibleCandidateEndpoint;
  to?: BibleCandidateEndpoint;
  evidence: BibleCandidateEvidence;
  confidence: number;
  rationale: string;
  metadata: Record<string, unknown>;
}

export interface SectionForCandidateExtraction {
  id?: string;
  label: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface BibleCandidateExtractionOptions {
  granularity?: BibleCandidateGranularity;
  families?: readonly BibleCandidateFamily[];
}

function stableHash(value: string, length = 16): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(length, '0').slice(0, length);
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lowered(value: string): string {
  return value.toLocaleLowerCase('it-IT');
}

function metadataPath(metadata: Record<string, unknown>): string[] {
  return Array.isArray(metadata.path) ? metadata.path.map(normalizeText).filter(Boolean) : [];
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function snippet(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 400 ? `${normalized.slice(0, 397).trim()}...` : normalized;
}

function candidateId(input: {
  sourceId: string;
  sectionKey: string;
  candidateKind: BibleCandidateKind;
  targetType?: string;
  label?: string;
  relationKind?: string;
}): string {
  const hash = stableHash([input.sourceId, input.sectionKey, input.candidateKind, input.targetType, input.label, input.relationKind].join('\n'));
  return `bible-candidate-${hash}`;
}

function nodeCandidate(input: {
  sourceId: string;
  sectionKey: string;
  sectionLabel: string;
  contentHash?: string;
  targetType: NovelNodeType;
  label: string;
  content: string;
  rationale: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}): BibleCandidate {
  return {
    candidateId: candidateId({
      sourceId: input.sourceId,
      sectionKey: input.sectionKey,
      candidateKind: 'node',
      targetType: input.targetType,
      label: input.label,
    }),
    candidateKind: 'node',
    targetType: input.targetType,
    label: input.label,
    content: input.content,
    evidence: {
      sourceId: input.sourceId,
      sectionKey: input.sectionKey,
      sectionLabel: input.sectionLabel,
      contentHash: input.contentHash,
      path: Array.isArray(input.metadata?.extractedFromPath) ? input.metadata.extractedFromPath.map(String) : undefined,
      textSnippet: snippet(input.content),
    },
    confidence: input.confidence ?? 0.72,
    rationale: input.rationale,
    metadata: input.metadata ?? {},
  };
}

function familyForTargetType(targetType: NovelNodeType): BibleCandidateFamily {
  switch (targetType) {
    case 'character':
    case 'character_belief':
    case 'character_goal':
    case 'character_state':
    case 'character_trait':
    case 'character_voice':
    case 'character_wound':
    case 'emotional_state':
      return 'characters';
    case 'relationship_dynamic':
      return 'relationships';
    case 'knowledge_state':
    case 'secret':
    case 'revelation':
      return 'knowledge_secrets';
    case 'artifact':
    case 'entity_class':
    case 'faction':
    case 'power':
      return 'objects_powers_factions';
    case 'timeline_event':
    case 'precognitive_data':
    case 'prophecy':
      return 'timeline';
    case 'world_rule':
    case 'narrative_constraint':
      return 'worldbuilding';
    case 'style_rule':
      return 'style';
    case 'motif':
    case 'symbol':
      return 'symbols';
    case 'theme':
      return 'themes';
    case 'glossary_term':
      return 'glossary';
    default:
      return 'plot';
  }
}

function classifyTarget(path: string[], heading: string): { targetType: NovelNodeType; label: string; rationale: string; family: BibleCandidateFamily } | null {
  const joined = lowered([...path, heading].join(' / '));
  const pathLower = path.map(lowered);
  const parent = pathLower.length > 1 ? pathLower[pathLower.length - 2] : '';
  const headingLower = lowered(heading);
  const secondLevel = path[1];

  if (includesAny(joined, ['glossario'])) return { targetType: 'glossary_term', label: heading, rationale: 'Sezione appartenente al glossario.', family: 'glossary' };
  if (includesAny(joined, ['cronologia', 'timeline'])) {
    if (path.length > 1 || includesAny(headingLower, ['evento', 'capitolo', 'prologo', 'epilogo'])) {
      return { targetType: 'timeline_event', label: heading, rationale: 'Sezione appartenente alla cronologia o timeline.', family: 'timeline' };
    }
    return null;
  }
  if (includesAny(joined, ['worldbuilding', 'regole', 'fondamenta', 'poteri', 'soprannaturale', 'angeli', 'arcangeli'])) {
    return { targetType: 'world_rule', label: heading, rationale: 'Sezione di worldbuilding o regola del mondo.', family: 'worldbuilding' };
  }
  if (includesAny(joined, ['luoghi', 'ambientazione', 'citta', 'città', 'liceo', 'stanza', 'casa'])) {
    return { targetType: 'location', label: heading, rationale: 'Sezione relativa ad ambientazione o luogo.', family: 'worldbuilding' };
  }
  if (includesAny(joined, ['stile', 'tono', 'voce narrante', 'pov', 'ritmo'])) {
    return { targetType: 'style_rule', label: heading, rationale: 'Sezione relativa a stile, tono o voce narrante.', family: 'style' };
  }
  if (includesAny(joined, ['tema', 'temi'])) return { targetType: 'theme', label: heading.replace(/:$/, ''), rationale: 'Sezione tematica.', family: 'themes' };
  if (includesAny(joined, ['sinossi', 'trama'])) return { targetType: 'plot_thread', label: heading, rationale: 'Sezione di trama o sinossi.', family: 'plot' };

  if (includesAny(joined, ['dossier dei personaggi', 'personaggi'])) {
    if (includesAny(headingLower, ['relazioni', 'dinamica'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'relationship_dynamic', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione sulle relazioni del personaggio.', family: 'relationships' };
    }
    if (includesAny(headingLower, ['voce'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'character_voice', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione sulla voce del personaggio.', family: 'characters' };
    }
    if (includesAny(headingLower, ['stato', 'fase', 'arco', 'evoluzione', 'sviluppo'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'character_state', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione su arco o stato evolutivo del personaggio.', family: 'characters' };
    }
    if (path.length === 2 && !includesAny(headingLower, ['personaggi', 'dossier', 'secondari', 'cornice'])) {
      return { targetType: 'character', label: heading, rationale: 'Sezione principale di un personaggio.', family: 'characters' };
    }
    if (path.length > 2 && parent && !includesAny(parent, ['personaggi', 'dossier'])) {
      return { targetType: 'character_state', label: `${path[path.length - 2]} - ${heading}`, rationale: 'Sottosezione del dossier personaggio.', family: 'characters' };
    }
  }

  return null;
}

function sentenceCandidates(section: SectionForCandidateExtraction, sourceId: string, sectionKey: string, heading: string, path: string[]): BibleCandidate[] {
  const sentences = section.content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= 18)
    .slice(0, 24);
  const candidates: BibleCandidate[] = [];
  for (const [index, sentence] of sentences.entries()) {
    const haystack = lowered([...path, heading, sentence].join(' / '));
    const sectionLabel = section.label;
    const contentHash = typeof section.metadata.contentHash === 'string' ? section.metadata.contentHash : undefined;
    candidates.push(nodeCandidate({
      sourceId,
      sectionKey,
      sectionLabel,
      contentHash,
      targetType: 'bible_claim',
      label: `${heading} - claim ${index + 1}`,
      content: sentence,
      rationale: 'Claim atomico estratto da una frase/paragrafo della sezione Bibbia.',
      confidence: 0.62,
      metadata: {
        extractedFromPath: path,
        extractedHeading: heading,
        sourceSectionLabel: section.label,
        family: 'plot',
        granularity: 'atomic',
        extractionRule: 'sentence_claim',
        requiresReview: true,
      },
    }));

    const typed: Array<{ targetType: NovelNodeType; family: BibleCandidateFamily; rule: string }> = [];
    if (includesAny(haystack, ['segreto', 'nasconde', 'nascosto'])) typed.push({ targetType: 'secret', family: 'knowledge_secrets', rule: 'secret_keyword' });
    if (includesAny(haystack, ['sa ', 'sapere', 'conosce', 'non sa', 'non conosce'])) typed.push({ targetType: 'knowledge_state', family: 'knowledge_secrets', rule: 'knowledge_keyword' });
    if (includesAny(haystack, ['rivelazione', 'rivela', 'scopre'])) typed.push({ targetType: 'revelation', family: 'knowledge_secrets', rule: 'revelation_keyword' });
    if (includesAny(haystack, ['oggetto', 'artefatto', 'reliquia', 'occhiali', 'anello', 'spada'])) typed.push({ targetType: 'artifact', family: 'objects_powers_factions', rule: 'artifact_keyword' });
    if (includesAny(haystack, ['potere', 'poteri', 'dono', 'abilita', 'abilita'])) typed.push({ targetType: 'power', family: 'objects_powers_factions', rule: 'power_keyword' });
    if (includesAny(haystack, ['fazione', 'ordine', 'gruppo', 'casata', 'gerarchia'])) typed.push({ targetType: 'faction', family: 'objects_powers_factions', rule: 'faction_keyword' });
    if (includesAny(haystack, ['profezia', 'profetico'])) typed.push({ targetType: 'prophecy', family: 'timeline', rule: 'prophecy_keyword' });
    if (includesAny(haystack, ['precogn', 'premonizione', 'visione'])) typed.push({ targetType: 'precognitive_data', family: 'timeline', rule: 'precognition_keyword' });
    if (includesAny(haystack, ['simbolo', 'simbolico'])) typed.push({ targetType: 'symbol', family: 'symbols', rule: 'symbol_keyword' });
    if (includesAny(haystack, ['motivo', 'ricorre', 'ricorrente'])) typed.push({ targetType: 'motif', family: 'symbols', rule: 'motif_keyword' });
    if (includesAny(haystack, ['vincolo', 'divieto', 'deve', 'non puo'])) typed.push({ targetType: 'narrative_constraint', family: 'worldbuilding', rule: 'constraint_keyword' });
    if (includesAny(haystack, ['evento', 'capitolo', 'prima', 'dopo', 'timeline', 'cronologia'])) typed.push({ targetType: 'timeline_event', family: 'timeline', rule: 'timeline_keyword' });
    if (includesAny(haystack, ['obiettivo', 'vuole', 'desidera'])) typed.push({ targetType: 'character_goal', family: 'characters', rule: 'character_goal_keyword' });
    if (includesAny(haystack, ['crede', 'convinzione'])) typed.push({ targetType: 'character_belief', family: 'characters', rule: 'character_belief_keyword' });
    if (includesAny(haystack, ['ferita', 'trauma'])) typed.push({ targetType: 'character_wound', family: 'characters', rule: 'character_wound_keyword' });
    if (includesAny(haystack, ['tratto', 'carattere', 'temperamento'])) typed.push({ targetType: 'character_trait', family: 'characters', rule: 'character_trait_keyword' });

    for (const item of typed) {
      candidates.push(nodeCandidate({
        sourceId,
        sectionKey,
        sectionLabel,
        contentHash,
        targetType: item.targetType,
        label: `${heading} - ${item.targetType} ${index + 1}`,
        content: sentence,
        rationale: `Candidato atomico tipizzato tramite regola ${item.rule}.`,
        confidence: 0.68,
        metadata: {
          extractedFromPath: path,
          extractedHeading: heading,
          sourceSectionLabel: section.label,
          family: item.family,
          granularity: 'atomic',
          extractionRule: item.rule,
          requiresReview: true,
        },
      }));
    }
  }
  return candidates;
}

function filterByFamily(candidates: BibleCandidate[], families?: readonly BibleCandidateFamily[]): BibleCandidate[] {
  if (!families?.length) return candidates;
  const allowed = new Set<string>(families);
  return candidates.filter((candidate) => {
    const family = typeof candidate.metadata.family === 'string' ? candidate.metadata.family : familyForTargetType(candidate.targetType ?? 'plot_thread');
    return allowed.has(family);
  });
}

export function extractBibleCandidatesFromSection(section: SectionForCandidateExtraction, options: BibleCandidateExtractionOptions = {}): BibleCandidate[] {
  const sourceId = normalizeText(section.metadata.sourceId);
  const sectionKey = normalizeText(section.metadata.sectionKey);
  const heading = normalizeText(section.metadata.heading || section.label);
  if (!sourceId || !sectionKey || !heading || !section.content.trim()) return [];
  const path = metadataPath(section.metadata);
  const granularity = options.granularity ?? 'section';
  const candidates: BibleCandidate[] = [];
  const classified = classifyTarget(path, heading);
  if ((granularity === 'section' || granularity === 'both') && classified && COMMITTABLE_BIBLE_NODE_TYPE_SET.has(classified.targetType)) {
    candidates.push(nodeCandidate({
      sourceId,
      sectionKey,
      sectionLabel: section.label,
      contentHash: typeof section.metadata.contentHash === 'string' ? section.metadata.contentHash : undefined,
      targetType: classified.targetType,
      label: classified.label,
      content: section.content,
      rationale: classified.rationale,
      metadata: {
        extractedFromPath: path,
        extractedHeading: heading,
        sourceSectionLabel: section.label,
        family: classified.family,
        granularity: 'section',
        extractionRule: 'heading_path_classifier',
        requiresReview: false,
      },
    }));
  }
  if (granularity === 'atomic' || granularity === 'both') {
    candidates.push(...sentenceCandidates(section, sourceId, sectionKey, heading, path));
  }
  return filterByFamily(candidates, options.families);
}

export function validateBibleCandidateForCommit(candidate: BibleCandidate): string[] {
  const errors: string[] = [];
  if (!candidate.evidence?.sourceId?.trim()) errors.push('missing_evidence_sourceId');
  if (!candidate.evidence?.sectionKey?.trim()) errors.push('missing_evidence_sectionKey');
  if (candidate.evidence?.span) {
    const { startChar, endChar, paragraphIndex } = candidate.evidence.span;
    if (startChar !== undefined && (!Number.isInteger(startChar) || startChar < 0)) errors.push('invalid_evidence_span');
    if (endChar !== undefined && (!Number.isInteger(endChar) || endChar < 0)) errors.push('invalid_evidence_span');
    if (startChar !== undefined && endChar !== undefined && endChar < startChar) errors.push('invalid_evidence_span');
    if (paragraphIndex !== undefined && (!Number.isInteger(paragraphIndex) || paragraphIndex < 0)) errors.push('invalid_evidence_span');
  }
  const granularity = typeof candidate.metadata?.granularity === 'string' ? candidate.metadata.granularity : undefined;
  const isAtomicClaim = candidate.targetType === 'bible_claim' || granularity === 'atomic';
  if (isAtomicClaim && !candidate.evidence?.textSnippet?.trim()) errors.push('missing_atomic_textSnippet');
  if (candidate.candidateKind === 'node') {
    if (!candidate.targetType || !isNovelNodeType(candidate.targetType)) errors.push('invalid_target_type');
    if (candidate.targetType && !COMMITTABLE_BIBLE_NODE_TYPE_SET.has(candidate.targetType)) errors.push('target_type_not_committable');
    if (!candidate.label?.trim()) errors.push('missing_label');
    if (candidate.targetType === 'bible_claim' && !candidate.content?.trim()) errors.push('missing_claim_content');
  } else if (candidate.candidateKind === 'edge') {
    if (!candidate.relationKind || !isCanonicalKind(candidate.relationKind)) errors.push('invalid_relation_kind');
    if (!candidate.from?.type || !isNovelNodeType(candidate.from.type) || !candidate.from.label?.trim()) errors.push('invalid_from_endpoint');
    if (!candidate.to?.type || !isNovelNodeType(candidate.to.type) || !candidate.to.label?.trim()) errors.push('invalid_to_endpoint');
  } else {
    errors.push('invalid_candidate_kind');
  }
  return errors;
}
