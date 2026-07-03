import type { NovelNodeType } from './domain.js';
import type { ContentCandidate, ContentCandidateEvidence, BibleCandidateFamily } from './bibleCandidates.js';

/**
 * Extracts structured, evidence-anchored candidates from the FINAL text of a chapter (or one of
 * its editorial blocks) — the chapter-domain counterpart of bibleCandidates.ts's atomic
 * extraction. Unlike the Bible, a chapter has no heading/path hierarchy to classify by, so there
 * is no "section granularity": every candidate here is sentence-level, anchored to the exact
 * sentence it was read from.
 *
 * Candidates are plain data (`ContentCandidate[]`), never persisted as graph nodes: a chapter is
 * committed once, in its final form, in a single pass (novel_commit_chapter_candidates) — there is
 * no multi-session backlog to keep around, so there is nothing that needs graph-level scaffolding
 * or cleanup.
 */

export interface ChapterForCandidateExtraction {
  /** Stable id of the canonical `chapter` graph node (used as evidence.sourceId). */
  sourceId: string;
  /** Human-readable chapter label, e.g. "Capitolo 12" or "Prologo". */
  label: string;
  /** The final text to extract from — a whole chapter or a single editorial block. */
  content: string;
  /** Identifies the sub-unit within the chapter this text came from (block label, or "full"). */
  sectionKey: string;
}

const MAX_SENTENCES_PER_CALL = 240;
const MIN_SENTENCE_LENGTH = 18;

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

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function snippet(text: string): string {
  const normalized = normalizeText(text);
  return normalized.length > 400 ? `${normalized.slice(0, 397).trim()}...` : normalized;
}

function candidateId(input: { sourceId: string; sectionKey: string; targetType: string; label: string; index: number }): string {
  const hash = stableHash([input.sourceId, input.sectionKey, input.targetType, input.label, input.index].join('\n'));
  return `chapter-candidate-${hash}`;
}

/**
 * Keyword rules mirroring bibleCandidates.ts's atomic extraction, plus two additions
 * (`location`, `character_state`) that matter more for narrative prose than for a structured
 * Bible outline: chapters are where a place gets described or a character visibly changes.
 */
const TYPED_RULES: Array<{ targetType: NovelNodeType; family: BibleCandidateFamily; rule: string; keywords: string[] }> = [
  { targetType: 'secret', family: 'knowledge_secrets', rule: 'secret_keyword', keywords: ['segreto', 'nasconde', 'nascosto'] },
  { targetType: 'knowledge_state', family: 'knowledge_secrets', rule: 'knowledge_keyword', keywords: ['sa ', 'sapere', 'conosce', 'non sa', 'non conosce'] },
  { targetType: 'revelation', family: 'knowledge_secrets', rule: 'revelation_keyword', keywords: ['rivelazione', 'rivela', 'scopre'] },
  { targetType: 'artifact', family: 'objects_powers_factions', rule: 'artifact_keyword', keywords: ['oggetto', 'artefatto', 'reliquia', 'occhiali', 'anello', 'spada'] },
  { targetType: 'power', family: 'objects_powers_factions', rule: 'power_keyword', keywords: ['potere', 'poteri', 'dono', 'abilita', 'abilità'] },
  { targetType: 'faction', family: 'objects_powers_factions', rule: 'faction_keyword', keywords: ['fazione', 'ordine', 'gruppo', 'casata', 'gerarchia'] },
  { targetType: 'prophecy', family: 'timeline', rule: 'prophecy_keyword', keywords: ['profezia', 'profetico'] },
  { targetType: 'precognitive_data', family: 'timeline', rule: 'precognition_keyword', keywords: ['precogn', 'premonizione', 'visione'] },
  { targetType: 'symbol', family: 'symbols', rule: 'symbol_keyword', keywords: ['simbolo', 'simbolico'] },
  { targetType: 'motif', family: 'symbols', rule: 'motif_keyword', keywords: ['motivo', 'ricorre', 'ricorrente'] },
  { targetType: 'narrative_constraint', family: 'worldbuilding', rule: 'constraint_keyword', keywords: ['vincolo', 'divieto', 'deve', 'non puo', 'non può'] },
  { targetType: 'timeline_event', family: 'timeline', rule: 'timeline_keyword', keywords: ['evento', 'prima', 'dopo', 'timeline', 'cronologia'] },
  { targetType: 'character_goal', family: 'characters', rule: 'character_goal_keyword', keywords: ['obiettivo', 'vuole', 'desidera'] },
  { targetType: 'character_belief', family: 'characters', rule: 'character_belief_keyword', keywords: ['crede', 'convinzione'] },
  { targetType: 'character_wound', family: 'characters', rule: 'character_wound_keyword', keywords: ['ferita', 'trauma'] },
  { targetType: 'character_trait', family: 'characters', rule: 'character_trait_keyword', keywords: ['tratto', 'carattere', 'temperamento'] },
  { targetType: 'location', family: 'worldbuilding', rule: 'location_keyword', keywords: ['stanza', 'casa', 'citta', 'città', 'strada', 'edificio', 'palazzo', 'scuola', 'liceo', 'giardino', 'bosco', 'foresta'] },
  { targetType: 'character_state', family: 'characters', rule: 'character_state_keyword', keywords: ['ora indossa', 'adesso porta', 'per la prima volta', 'da quel momento', 'era cambiat', 'non era piu', 'non era più'] },
];

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= MIN_SENTENCE_LENGTH)
    .slice(0, MAX_SENTENCES_PER_CALL);
}

function evidenceFor(chapter: ChapterForCandidateExtraction, sentence: string): ContentCandidateEvidence {
  return {
    sourceId: chapter.sourceId,
    sectionKey: chapter.sectionKey,
    sectionLabel: chapter.label,
    textSnippet: snippet(sentence),
  };
}

/**
 * Extracts one candidate per keyword match found in each sentence of the chapter/block text.
 * Sentences matching no rule produce no candidate — this is a deliberately conservative,
 * high-precision extraction (only facts that plausibly belong to a specific canonical category),
 * not an exhaustive paraphrase of the prose.
 */
export function extractChapterCandidates(chapter: ChapterForCandidateExtraction): ContentCandidate[] {
  const sourceId = normalizeText(chapter.sourceId);
  const sectionKey = normalizeText(chapter.sectionKey) || 'full';
  if (!sourceId || !chapter.content.trim()) return [];

  const candidates: ContentCandidate[] = [];
  const sentences = splitSentences(chapter.content);

  for (const [index, sentence] of sentences.entries()) {
    const haystack = lowered(sentence);
    for (const rule of TYPED_RULES) {
      if (!includesAny(haystack, rule.keywords)) continue;
      const label = `${chapter.label} - ${rule.targetType} ${index + 1}`;
      candidates.push({
        candidateId: candidateId({ sourceId, sectionKey, targetType: rule.targetType, label, index }),
        candidateKind: 'node',
        targetType: rule.targetType,
        label,
        content: sentence,
        evidence: evidenceFor({ ...chapter, sourceId, sectionKey }, sentence),
        confidence: 0.68,
        rationale: `Candidato estratto dal testo del capitolo tramite regola ${rule.rule}.`,
        metadata: {
          extractedFromChapter: chapter.label,
          family: rule.family,
          granularity: 'atomic',
          extractionRule: rule.rule,
          requiresReview: true,
        },
      });
    }
  }

  return candidates;
}
