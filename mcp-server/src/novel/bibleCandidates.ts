import { isCanonicalKind } from '../graph/ontology.js';
import { isNovelNodeType, type NovelNodeType } from './domain.js';

export const BIBLE_CANDIDATE_STATUSES = ['pending', 'committed', 'rejected'] as const;
export type BibleCandidateStatus = typeof BIBLE_CANDIDATE_STATUSES[number];

export const BIBLE_CANDIDATE_KINDS = ['node', 'edge'] as const;
export type BibleCandidateKind = typeof BIBLE_CANDIDATE_KINDS[number];

export const COMMITTABLE_BIBLE_NODE_TYPES = [
  'chapter',
  'character',
  'character_state',
  'character_voice',
  'foreshadowing',
  'glossary_term',
  'location',
  'plot_thread',
  'relationship_dynamic',
  'scene',
  'style_rule',
  'theme',
  'timeline_event',
  'world_rule',
] as const satisfies readonly NovelNodeType[];

export const COMMITTABLE_BIBLE_NODE_TYPE_SET: ReadonlySet<string> = new Set(COMMITTABLE_BIBLE_NODE_TYPES);

export interface BibleCandidateEvidence {
  sourceId: string;
  sectionKey: string;
  sectionLabel?: string;
  contentHash?: string;
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
      textSnippet: snippet(input.content),
    },
    confidence: input.confidence ?? 0.72,
    rationale: input.rationale,
    metadata: input.metadata ?? {},
  };
}

function classifyTarget(path: string[], heading: string): { targetType: NovelNodeType; label: string; rationale: string } | null {
  const joined = lowered([...path, heading].join(' / '));
  const pathLower = path.map(lowered);
  const parent = pathLower.length > 1 ? pathLower[pathLower.length - 2] : '';
  const headingLower = lowered(heading);
  const secondLevel = path[1];

  if (includesAny(joined, ['glossario'])) return { targetType: 'glossary_term', label: heading, rationale: 'Sezione appartenente al glossario.' };
  if (includesAny(joined, ['cronologia', 'timeline'])) {
    if (path.length > 1 || includesAny(headingLower, ['evento', 'capitolo', 'prologo', 'epilogo'])) {
      return { targetType: 'timeline_event', label: heading, rationale: 'Sezione appartenente alla cronologia o timeline.' };
    }
    return null;
  }
  if (includesAny(joined, ['worldbuilding', 'regole', 'fondamenta', 'poteri', 'soprannaturale', 'angeli', 'arcangeli'])) {
    return { targetType: 'world_rule', label: heading, rationale: 'Sezione di worldbuilding o regola del mondo.' };
  }
  if (includesAny(joined, ['luoghi', 'ambientazione', 'citta', 'città', 'liceo', 'stanza', 'casa'])) {
    return { targetType: 'location', label: heading, rationale: 'Sezione relativa ad ambientazione o luogo.' };
  }
  if (includesAny(joined, ['stile', 'tono', 'voce narrante', 'pov', 'ritmo'])) {
    return { targetType: 'style_rule', label: heading, rationale: 'Sezione relativa a stile, tono o voce narrante.' };
  }
  if (includesAny(joined, ['tema', 'temi'])) return { targetType: 'theme', label: heading.replace(/:$/, ''), rationale: 'Sezione tematica.' };
  if (includesAny(joined, ['sinossi', 'trama'])) return { targetType: 'plot_thread', label: heading, rationale: 'Sezione di trama o sinossi.' };

  if (includesAny(joined, ['dossier dei personaggi', 'personaggi'])) {
    if (includesAny(headingLower, ['relazioni', 'dinamica'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'relationship_dynamic', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione sulle relazioni del personaggio.' };
    }
    if (includesAny(headingLower, ['voce'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'character_voice', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione sulla voce del personaggio.' };
    }
    if (includesAny(headingLower, ['stato', 'fase', 'arco', 'evoluzione', 'sviluppo'])) {
      const character = secondLevel && !includesAny(lowered(secondLevel), ['personaggi', 'dossier']) ? secondLevel : undefined;
      return { targetType: 'character_state', label: character ? `${character} - ${heading}` : heading, rationale: 'Sezione su arco o stato evolutivo del personaggio.' };
    }
    if (path.length === 2 && !includesAny(headingLower, ['personaggi', 'dossier', 'secondari', 'cornice'])) {
      return { targetType: 'character', label: heading, rationale: 'Sezione principale di un personaggio.' };
    }
    if (path.length > 2 && parent && !includesAny(parent, ['personaggi', 'dossier'])) {
      return { targetType: 'character_state', label: `${path[path.length - 2]} - ${heading}`, rationale: 'Sottosezione del dossier personaggio.' };
    }
  }

  return null;
}

export function extractBibleCandidatesFromSection(section: SectionForCandidateExtraction): BibleCandidate[] {
  const sourceId = normalizeText(section.metadata.sourceId);
  const sectionKey = normalizeText(section.metadata.sectionKey);
  const heading = normalizeText(section.metadata.heading || section.label);
  if (!sourceId || !sectionKey || !heading || !section.content.trim()) return [];
  const path = metadataPath(section.metadata);
  const classified = classifyTarget(path, heading);
  if (!classified || !COMMITTABLE_BIBLE_NODE_TYPE_SET.has(classified.targetType)) return [];
  return [
    nodeCandidate({
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
      },
    }),
  ];
}

export function validateBibleCandidateForCommit(candidate: BibleCandidate): string[] {
  const errors: string[] = [];
  if (!candidate.evidence?.sourceId?.trim()) errors.push('missing_evidence_sourceId');
  if (!candidate.evidence?.sectionKey?.trim()) errors.push('missing_evidence_sectionKey');
  if (candidate.candidateKind === 'node') {
    if (!candidate.targetType || !isNovelNodeType(candidate.targetType)) errors.push('invalid_target_type');
    if (candidate.targetType && !COMMITTABLE_BIBLE_NODE_TYPE_SET.has(candidate.targetType)) errors.push('target_type_not_committable');
    if (!candidate.label?.trim()) errors.push('missing_label');
  } else if (candidate.candidateKind === 'edge') {
    if (!candidate.relationKind || !isCanonicalKind(candidate.relationKind)) errors.push('invalid_relation_kind');
    if (!candidate.from?.type || !isNovelNodeType(candidate.from.type) || !candidate.from.label?.trim()) errors.push('invalid_from_endpoint');
    if (!candidate.to?.type || !isNovelNodeType(candidate.to.type) || !candidate.to.label?.trim()) errors.push('invalid_to_endpoint');
  } else {
    errors.push('invalid_candidate_kind');
  }
  return errors;
}
