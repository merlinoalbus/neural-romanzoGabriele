import type { GraphNode } from '../graph/neo4jStore.js';
import { normalizeChapterLabel } from './domain.js';

export type NarrativeContextGroups = {
  chapters: GraphNode[];
  drafts: GraphNode[];
  characters: GraphNode[];
  characterVoices: GraphNode[];
  relationshipDynamics: GraphNode[];
  themes: GraphNode[];
  locations: GraphNode[];
  worldRules: GraphNode[];
  styleRules: GraphNode[];
  plotThreads: GraphNode[];
  foreshadowing: GraphNode[];
  glossaryTerms: GraphNode[];
  timelineEvents: GraphNode[];
  other: GraphNode[];
};

export type AuditSeverity = 'info' | 'warning' | 'error';

export type ContinuityFinding = {
  code: string;
  severity: AuditSeverity;
  message: string;
  evidence?: Record<string, unknown>;
};

export type AuditCheck = 'structure' | 'characters' | 'style' | 'worldbuilding' | 'themes' | 'timeline';

export const DEFAULT_AUDIT_CHECKS: readonly AuditCheck[] = ['structure', 'characters', 'style', 'worldbuilding', 'themes', 'timeline'];

export function composeRecallQuery(input: { task: string; chapterNumber?: number; query?: string; characters?: string[] }): string {
  const parts = [
    input.task,
    input.query,
    input.chapterNumber ? normalizeChapterLabel(input.chapterNumber) : undefined,
    ...(input.characters ?? []),
  ].map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return [...new Set(parts)].join(' ');
}

export function emptyNarrativeContextGroups(): NarrativeContextGroups {
  return {
    chapters: [],
    drafts: [],
    characters: [],
    characterVoices: [],
    relationshipDynamics: [],
    themes: [],
    locations: [],
    worldRules: [],
    styleRules: [],
    plotThreads: [],
    foreshadowing: [],
    glossaryTerms: [],
    timelineEvents: [],
    other: [],
  };
}

export function groupNarrativeContext(nodes: GraphNode[], opts: { includeDrafts?: boolean } = {}): NarrativeContextGroups {
  const groups = emptyNarrativeContextGroups();
  for (const node of nodes) {
    if (!opts.includeDrafts && (node.type === 'chapter_draft' || node.type === 'document' || node.type === 'chunk')) continue;
    switch (node.type) {
      case 'chapter':
        groups.chapters.push(node);
        break;
      case 'chapter_draft':
        groups.drafts.push(node);
        break;
      case 'character':
        groups.characters.push(node);
        break;
      case 'character_voice':
        groups.characterVoices.push(node);
        break;
      case 'relationship_dynamic':
        groups.relationshipDynamics.push(node);
        break;
      case 'theme':
        groups.themes.push(node);
        break;
      case 'location':
        groups.locations.push(node);
        break;
      case 'world_rule':
        groups.worldRules.push(node);
        break;
      case 'style_rule':
        groups.styleRules.push(node);
        break;
      case 'plot_thread':
        groups.plotThreads.push(node);
        break;
      case 'foreshadowing':
        groups.foreshadowing.push(node);
        break;
      case 'glossary_term':
        groups.glossaryTerms.push(node);
        break;
      case 'timeline_event':
        groups.timelineEvents.push(node);
        break;
      default:
        groups.other.push(node);
        break;
    }
  }
  return groups;
}

function normalizeText(text: string): string {
  return text.toLocaleLowerCase('it-IT');
}

function candidateTerms(node: GraphNode): string[] {
  const terms = new Set<string>([node.label]);
  const title = node.metadata.title;
  if (typeof title === 'string') terms.add(title);
  const aliases = node.metadata.aliases;
  if (Array.isArray(aliases)) {
    for (const alias of aliases) if (typeof alias === 'string') terms.add(alias);
  }
  const parenthetical = node.label.match(/\(([^)]+)\)/);
  if (parenthetical) terms.add(parenthetical[1]);
  const withoutParenthetical = node.label.replace(/\s*\([^)]*\)/g, '').trim();
  if (withoutParenthetical) terms.add(withoutParenthetical);
  const firstToken = withoutParenthetical.split(/\s+/)[0];
  if (firstToken && firstToken.length > 2) terms.add(firstToken);
  return [...terms].map((term) => term.trim()).filter((term) => term.length > 2);
}

export function detectMentionedCharacters(content: string, characters: GraphNode[]): GraphNode[] {
  const haystack = normalizeText(content);
  return characters.filter((character) => candidateTerms(character).some((term) => haystack.includes(normalizeText(term))));
}

export function auditChapterContent(input: {
  chapterNumber: number;
  content: string;
  checks?: AuditCheck[];
  chapter: GraphNode | null;
  characters: GraphNode[];
  styleRules: GraphNode[];
  worldRules: GraphNode[];
  themes: GraphNode[];
  timelineEvents: GraphNode[];
}): { findings: ContinuityFinding[]; detectedCharacters: GraphNode[] } {
  const checks = new Set(input.checks?.length ? input.checks : DEFAULT_AUDIT_CHECKS);
  const findings: ContinuityFinding[] = [];
  const text = input.content.trim();

  if (!text) {
    findings.push({
      code: 'empty_content',
      severity: 'error',
      message: 'Il contenuto del capitolo e vuoto: non e possibile eseguire audit narrativo.',
    });
  }

  if (checks.has('structure') && !input.chapter) {
    findings.push({
      code: 'missing_chapter_outline',
      severity: 'warning',
      message: `Non esiste ancora un nodo strutturale per ${normalizeChapterLabel(input.chapterNumber)}.`,
      evidence: { chapterNumber: input.chapterNumber },
    });
  }

  const detectedCharacters = detectMentionedCharacters(input.content, input.characters);
  if (checks.has('characters')) {
    if (!input.characters.length) {
      findings.push({
        code: 'missing_character_catalog',
        severity: 'warning',
        message: 'Il grafo non contiene ancora un catalogo personaggi da usare per il controllo delle voci e delle relazioni.',
      });
    } else if (text && !detectedCharacters.length) {
      findings.push({
        code: 'no_known_character_mentions',
        severity: 'info',
        message: 'Nel testo non sono stati rilevati nomi del catalogo personaggi disponibile.',
      });
    }
  }

  if (checks.has('style') && !input.styleRules.length) {
    findings.push({
      code: 'missing_style_rules',
      severity: 'warning',
      message: 'Il grafo non contiene ancora regole stilistiche per validare voce narrante, tempo verbale o tono.',
    });
  }

  if (checks.has('worldbuilding') && !input.worldRules.length) {
    findings.push({
      code: 'missing_world_rules',
      severity: 'warning',
      message: 'Il grafo non contiene ancora regole di worldbuilding per verificare elementi soprannaturali o vincoli del mondo.',
    });
  }

  if (checks.has('themes') && !input.themes.length) {
    findings.push({
      code: 'missing_theme_nodes',
      severity: 'warning',
      message: 'Il grafo non contiene ancora temi strutturati da confrontare con il capitolo.',
    });
  }

  if (checks.has('timeline') && !input.timelineEvents.length) {
    findings.push({
      code: 'missing_timeline_events',
      severity: 'warning',
      message: 'Il grafo non contiene ancora eventi timeline strutturati per controllare ordine e causalita.',
    });
  }

  return { findings, detectedCharacters };
}
