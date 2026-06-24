import type { GraphNode } from '../graph/neo4jStore.js';
import { NOVEL_TECHNICAL_NODE_TYPE_SET, normalizeChapterLabel } from './domain.js';

export type NarrativeContextGroups = {
  artifacts: GraphNode[];
  bibleClaims: GraphNode[];
  chapters: GraphNode[];
  drafts: GraphNode[];
  characters: GraphNode[];
  characterBeliefs: GraphNode[];
  characterGoals: GraphNode[];
  characterStates: GraphNode[];
  characterTraits: GraphNode[];
  characterVoices: GraphNode[];
  characterWounds: GraphNode[];
  conflicts: GraphNode[];
  emotionalStates: GraphNode[];
  entityClasses: GraphNode[];
  factions: GraphNode[];
  relationshipDynamics: GraphNode[];
  themes: GraphNode[];
  locations: GraphNode[];
  worldRules: GraphNode[];
  knowledgeStates: GraphNode[];
  motifs: GraphNode[];
  mysteries: GraphNode[];
  narrativeConstraints: GraphNode[];
  powers: GraphNode[];
  precognitiveData: GraphNode[];
  prophecies: GraphNode[];
  revelations: GraphNode[];
  secrets: GraphNode[];
  styleRules: GraphNode[];
  symbols: GraphNode[];
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
    artifacts: [],
    bibleClaims: [],
    chapters: [],
    drafts: [],
    characters: [],
    characterBeliefs: [],
    characterGoals: [],
    characterStates: [],
    characterTraits: [],
    characterVoices: [],
    characterWounds: [],
    conflicts: [],
    emotionalStates: [],
    entityClasses: [],
    factions: [],
    relationshipDynamics: [],
    themes: [],
    locations: [],
    worldRules: [],
    knowledgeStates: [],
    motifs: [],
    mysteries: [],
    narrativeConstraints: [],
    powers: [],
    precognitiveData: [],
    prophecies: [],
    revelations: [],
    secrets: [],
    styleRules: [],
    symbols: [],
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
    if (NOVEL_TECHNICAL_NODE_TYPE_SET.has(node.type)) continue;
    if (!opts.includeDrafts && (node.type === 'chapter_draft' || node.type === 'document' || node.type === 'chunk')) continue;
    switch (node.type) {
      case 'artifact':
        groups.artifacts.push(node);
        break;
      case 'bible_claim':
        groups.bibleClaims.push(node);
        break;
      case 'chapter':
        groups.chapters.push(node);
        break;
      case 'chapter_draft':
        groups.drafts.push(node);
        break;
      case 'character':
        groups.characters.push(node);
        break;
      case 'character_belief':
        groups.characterBeliefs.push(node);
        break;
      case 'character_goal':
        groups.characterGoals.push(node);
        break;
      case 'character_state':
        groups.characterStates.push(node);
        break;
      case 'character_trait':
        groups.characterTraits.push(node);
        break;
      case 'character_voice':
        groups.characterVoices.push(node);
        break;
      case 'character_wound':
        groups.characterWounds.push(node);
        break;
      case 'conflict':
        groups.conflicts.push(node);
        break;
      case 'emotional_state':
        groups.emotionalStates.push(node);
        break;
      case 'entity_class':
        groups.entityClasses.push(node);
        break;
      case 'faction':
        groups.factions.push(node);
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
      case 'knowledge_state':
        groups.knowledgeStates.push(node);
        break;
      case 'motif':
        groups.motifs.push(node);
        break;
      case 'mystery':
        groups.mysteries.push(node);
        break;
      case 'narrative_constraint':
        groups.narrativeConstraints.push(node);
        break;
      case 'power':
        groups.powers.push(node);
        break;
      case 'precognitive_data':
        groups.precognitiveData.push(node);
        break;
      case 'prophecy':
        groups.prophecies.push(node);
        break;
      case 'revelation':
        groups.revelations.push(node);
        break;
      case 'secret':
        groups.secrets.push(node);
        break;
      case 'style_rule':
        groups.styleRules.push(node);
        break;
      case 'symbol':
        groups.symbols.push(node);
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

export type CharacterTraitInfo = {
  id: string;
  label: string;
  content: string;
  charId: string;
  charLabel: string;
};

export type CharacterSecretInfo = {
  id: string;
  label: string;
  content: string;
  charId: string;
  charLabel: string;
  relKind: string;
};

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
  characterTraits?: CharacterTraitInfo[];
  characterSecrets?: CharacterSecretInfo[];
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

  // --- CONTROLLI SEMANTICI AVANZATI ---
  if (text) {
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

    // 1. Controllo dei Tratti Psicologici dei Personaggi
    if (checks.has('characters') && input.characterTraits?.length) {
      const traitContradictions: Record<string, string[]> = {
        timido: ['grida', 'urla', 'sfrontato', 'sfacciato', 'spavaldo', 'provoca'],
        insicuro: ['spavaldo', 'sicurissimo', 'orgoglioso', 'sfrontato'],
        introverso: ['sfrontato', 'spavaldo', 'provoca', 'chiacchiera'],
        calmo: ['furia', 'rabbia', 'aggressivo', 'colpisce', 'schiaffo', 'pugno', 'urla'],
        mite: ['colpisce', 'schiaffo', 'pugno', 'aggressivo', 'violento'],
        paziente: ['perde le staffe', 'furia', 'rabbia'],
        silenzioso: ['parla a lungo', 'spiega dettagliatamente', 'chiacchiera', 'urla'],
        taciturno: ['parla a lungo', 'chiacchiera'],
      };

      for (const char of detectedCharacters) {
        const charTraits = input.characterTraits.filter((t) => t.charId === char.id || t.charLabel === char.label);
        const charTerms = candidateTerms(char);

        for (const trait of charTraits) {
          const traitKey = normalizeText(trait.label);
          const contradictions = Object.keys(traitContradictions).find((k) => traitKey.includes(k));
          if (contradictions) {
            const forbiddenWords = traitContradictions[contradictions];
            for (const sentence of sentences) {
              const sentenceNorm = normalizeText(sentence);
              if (charTerms.some((term) => sentenceNorm.includes(normalizeText(term)))) {
                const matchedWord = forbiddenWords.find((w) => sentenceNorm.includes(w));
                if (matchedWord) {
                  findings.push({
                    code: 'character_trait_contradiction',
                    severity: 'warning',
                    message: `Possibile deviazione psicologica: il personaggio '${char.label}' (tratto: '${trait.label}') compie un'azione descritta come '${matchedWord}' nella frase: "${sentence}"`,
                    evidence: { characterId: char.id, traitId: trait.id, matchedWord, sentence },
                  });
                }
              }
            }
          }
        }
      }
    }

    // 2. Controllo delle Fughe di Segreti (Secret Leaks)
    if (checks.has('characters') && input.characterSecrets?.length) {
      for (const char of detectedCharacters) {
        const charSecrets = input.characterSecrets.filter((s) => s.charId === char.id && s.relKind === 'does_not_know');
        const charTerms = candidateTerms(char);

        for (const secret of charSecrets) {
          const secretKeywords = secret.label.split(/\s+/).map((w) => normalizeText(w.replace(/[^\w]/g, ''))).filter((w) => w.length > 4);
          if (secretKeywords.length > 0) {
            for (const sentence of sentences) {
              const sentenceNorm = normalizeText(sentence);
              if (charTerms.some((term) => sentenceNorm.includes(normalizeText(term)))) {
                const leakedWord = secretKeywords.find((kw) => sentenceNorm.includes(kw));
                if (leakedWord) {
                  findings.push({
                    code: 'secret_leak_detected',
                    severity: 'warning',
                    message: `Possibile fuga di segreti: il personaggio '${char.label}' menziona o si riferisce a elementi del segreto '${secret.label}' ('${secret.content}') che non dovrebbe conoscere (relazione: 'does_not_know'). Frase: "${sentence}"`,
                    evidence: { characterId: char.id, secretId: secret.id, leakedWord, sentence },
                  });
                }
              }
            }
          }
        }
      }
    }

    // 3. Verifiche di Worldbuilding e Vincoli del Mondo
    if (checks.has('worldbuilding') && input.worldRules.length) {
      for (const rule of input.worldRules) {
        const ruleKeywords = rule.label.split(/\s+/).map((w) => normalizeText(w.replace(/[^\w]/g, ''))).filter((w) => w.length > 4);
        if (ruleKeywords.length > 0) {
          for (const sentence of sentences) {
            const sentenceNorm = normalizeText(sentence);
            const matchedKeyword = ruleKeywords.find((kw) => sentenceNorm.includes(kw));
            if (matchedKeyword) {
              findings.push({
                code: 'world_rule_reference',
                severity: 'info',
                message: `Nota di worldbuilding: l'uso del termine '${matchedKeyword}' richiama la regola '${rule.label}'. Assicurati della coerenza rispetto a: "${rule.content}"`,
                evidence: { ruleId: rule.id, matchedKeyword, sentence },
              });
            }
          }
        }
      }
    }
  }

  return { findings, detectedCharacters };
}
