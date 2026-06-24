import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { config } from '../config.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';
import { normalizeChapterLabel } from '../novel/domain.js';
import { auditChapterContent } from '../novel/context.js';
import { buildBibleCoverageReport } from '../novel/bibleCoverage.js';
import {
  listBibleCandidatesForSource,
  listCanonicalNarrativeNodes,
  listCoverageFindingsForSource,
  gatherCoverageEdges,
} from './novelBible.js';

const metricsSchema = z.object({
  wordCount: z.number().optional(),
  characterCount: z.number().optional(),
  directChapterDegree: z.number().optional(),
  semanticEdgesCount: z.number().optional(),
  coverageFindingsCount: z.number().optional(),
  continuityFindingsCount: z.number().optional(),
  unmappedSectionsCount: z.number().optional(),
  duplicateCanonicalNodesCount: z.number().optional(),
  untypedClaimsCount: z.number().optional(),
});

export function registerNovelCoordinatorTools(server: McpServer): void {
  server.registerTool(
    'novel_verify_ingestion_threshold',
    {
      title: 'Novel verify ingestion threshold',
      description: 'Audits the readiness/eligibility threshold of a document part (bible_section) or chapter draft before committing.',
      inputSchema: {
        type: z.enum(['bible_section', 'chapter_draft']),
        chapterNumber: z.number().int().positive().optional(),
        sourceId: z.string().optional(),
        content: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        eligible: z.boolean(),
        score: z.number(),
        metrics: metricsSchema,
        blockers: z.array(z.string()),
        warnings: z.array(z.string()),
        error: errorObj,
      },
      annotations: {
        title: 'Novel verify ingestion threshold',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ type, chapterNumber, sourceId, content }) => {
      try {
        const projectId = config.projectId;
        const blockers: string[] = [];
        const warnings: string[] = [];
        let score = 100;
        const metrics: Record<string, number> = {};

        if (type === 'bible_section') {
          if (!sourceId) {
            return toolError('INVALID_INPUT', 'sourceId is required for bible_section type');
          }

          const limit = 500;
          const [sections, candidates, canonicalNodes, coverageFindings] = await Promise.all([
            kg.listNodesByTypeLabelPrefix('bible_section', `${sourceId}::`, { limit }),
            listBibleCandidatesForSource(sourceId, limit),
            listCanonicalNarrativeNodes(limit),
            listCoverageFindingsForSource(sourceId, limit),
          ]);
          const coverageEdges = await gatherCoverageEdges(canonicalNodes);
          const report = buildBibleCoverageReport({ sourceId, sections, candidates, canonicalNodes, coverageFindings, edges: coverageEdges });

          const totalSections = report.sectionCount;
          const unmappedCount = report.unmappedSections.length;
          const duplicateNodes = report.duplicateCanonicalNodes.length;
          const untypedClaims = report.untypedClaims.length;
          const missingEndpoints = report.pendingEdgeCandidatesWithMissingEndpoints.length;
          const genericRelatedTo = report.genericRelatedToEdges;
          const sectionMappedOnly = report.sectionMappedOnly.length;

          metrics.unmappedSectionsCount = unmappedCount;
          metrics.duplicateCanonicalNodesCount = duplicateNodes;
          metrics.untypedClaimsCount = untypedClaims;
          metrics.coverageFindingsCount = report.findings.length;

          if (totalSections === 0) {
            blockers.push(`Nessuna sezione Bibbia trovata nel database per il sourceId '${sourceId}'. Ingestione non avviata.`);
            score = 0;
          } else {
            // Unmapped ratio penalty
            const unmappedRatio = unmappedCount / totalSections;
            score -= Math.round(unmappedRatio * 40);

            if (unmappedRatio > 0.15) {
              blockers.push(`Più del 15% delle sezioni Bibbia non sono mappate (${(unmappedRatio * 100).toFixed(1)}%). Mappatura insufficiente.`);
            }

            // Blocker errors
            const reportErrors = report.findings.filter(f => f.severity === 'error');
            score -= reportErrors.length * 20;
            for (const err of reportErrors) {
              blockers.push(`Errore di copertura: ${err.message}`);
            }

            // Warning errors
            const reportWarnings = report.findings.filter(f => f.severity === 'warning');
            score -= reportWarnings.length * 10;
            for (const warn of reportWarnings) {
              warnings.push(`Warning di copertura: ${warn.message}`);
            }

            if (duplicateNodes > 0) {
              score -= duplicateNodes * 10;
              blockers.push(`Rilevati ${duplicateNodes} nodi canonici duplicati per tipo e label. Esegui consolidamento/deduplica.`);
            }
            if (untypedClaims > 0) {
              score -= untypedClaims * 10;
              blockers.push(`Rilevati ${untypedClaims} bible_claim canonici non collegati a nodi/archi semantici specifici.`);
            }
            if (missingEndpoints > 0) {
              score -= missingEndpoints * 10;
              blockers.push(`Rilevati ${missingEndpoints} candidati arco pendenti che puntano a endpoint non esistenti.`);
            }
            if (genericRelatedTo > 0) {
              warnings.push(`Sono presenti ${genericRelatedTo} relazioni generiche 'related_to'. Tipizzale per una migliore densità.`);
            }
            if (sectionMappedOnly > 0) {
              warnings.push(`Ci sono ${sectionMappedOnly} sezioni con solo mapping strutturale di sezione che richiedono estrazione atomica.`);
            }
          }

          score = Math.max(0, Math.min(100, score));
          const eligible = score >= 85 && blockers.length === 0;

          return toolStructured({
            ok: true,
            eligible,
            score,
            metrics,
            blockers,
            warnings,
          });

        } else {
          // chapter_draft
          if (chapterNumber === undefined) {
            return toolError('INVALID_INPUT', 'chapterNumber is required for chapter_draft type');
          }

          // 1. Find correct chapter node in database by parsing metadata in memory
          const chapterNodesInDb = await kg.runQuery(`
            MATCH (c:Entity {projectId: $projectId, type: 'chapter'})
            RETURN c.id AS id, c.label AS label, c.metadata AS metadata, c.content AS content, c.provenance AS provenance, c.createdAt AS createdAt, c.updatedAt AS updatedAt
          `, { projectId });

          let chapterNode: kg.GraphNode | null = null;
          let chapterLabel = normalizeChapterLabel(chapterNumber); // fallback
          let chapterId = '';

          for (const row of chapterNodesInDb) {
            const meta = JSON.parse(String(row.get('metadata') || '{}'));
            if (Number(meta.chapterNumber) === chapterNumber) {
              chapterId = String(row.get('id'));
              chapterLabel = String(row.get('label'));
              chapterNode = {
                id: chapterId,
                type: 'chapter',
                label: chapterLabel,
                content: String(row.get('content') || ''),
                metadata: meta,
                provenance: JSON.parse(String(row.get('provenance') || '{}')),
                createdAt: String(row.get('createdAt') || ''),
                updatedAt: String(row.get('updatedAt') || ''),
              };
              break;
            }
          }

          // Retrieve draft content if not provided
          let draftContent = content ?? '';
          if (!draftContent.trim()) {
            const draftNodes = await kg.runQuery(`
              MATCH (d:Entity {projectId: $projectId, type: 'chapter_draft'})
              RETURN d.content AS content, d.metadata AS metadata
            `, { projectId });
            const matchingDraft = draftNodes.find((row) => {
              const meta = JSON.parse(String(row.get('metadata') || '{}'));
              return Number(meta.chapterNumber) === chapterNumber;
            });
            if (matchingDraft) {
              draftContent = String(matchingDraft.get('content') || '');
            }
          }

          const wordCount = draftContent ? draftContent.trim().split(/\s+/).filter(Boolean).length : 0;
          const charCount = draftContent ? draftContent.length : 0;

          metrics.wordCount = wordCount;
          metrics.characterCount = charCount;

          if (!draftContent.trim()) {
            blockers.push('Contenuto della bozza del capitolo vuoto o non trovato.');
            score = 0;
          }

          // 2. Load all candidate chapter-related nodes in the database to map their IDs in memory
          const chapterNodesRes = await kg.runQuery(`
            MATCH (n:Entity {projectId: $projectId})
            WHERE n.type IN ['timeline_event', 'scene', 'emotional_state', 'character_wound', 'character_goal', 'narrative_constraint', 'chapter_draft', 'continuity_finding']
            RETURN n.id AS id, n.metadata AS metadata
          `, { projectId });

          const chapterNodeIds = new Set<string>();
          if (chapterId) chapterNodeIds.add(chapterId);
          for (const row of chapterNodesRes) {
            const meta = JSON.parse(String(row.get('metadata') || '{}'));
            if (Number(meta.chapterNumber) === chapterNumber) {
              chapterNodeIds.add(String(row.get('id')));
            }
          }

          const nodeIdsArray = Array.from(chapterNodeIds);

          // Fetch database audit inputs
          const [characters, styleRules, worldRules, themes, timelineEvents, traitsRes, secretsRes, degreeRes, semanticRes, dbFindingsRes, themeCountRes] = await Promise.all([
            kg.listNodesByType('character', { limit: 500 }),
            kg.listNodesByType('style_rule', { limit: 500 }),
            kg.listNodesByType('world_rule', { limit: 500 }),
            kg.listNodesByType('theme', { limit: 500 }),
            kg.listNodesByType('timeline_event', { limit: 500 }),
            kg.runQuery(`
              MATCH (t:Entity {type: 'character_trait'})-[:applies_to|part_of|derived_from]-(c:Entity {type: 'character'}) 
              RETURN t.id as id, t.label as label, t.content as content, c.id as charId, c.label as charLabel
            `, {}),
            kg.runQuery(`
              MATCH (s:Entity {type: 'secret'})-[r]-(c:Entity {type: 'character'}) 
              RETURN s.id as id, s.label as label, s.content as content, c.id as charId, c.label as charLabel, type(r) as relKind
            `, {}),
            chapterId ? kg.runQuery(`
              MATCH (c:Entity {projectId: $projectId, type: 'chapter', label: $chapterLabel})-[r:REL]-()
              RETURN count(r) AS degree
            `, { projectId, chapterLabel }) : Promise.resolve([]),
            nodeIdsArray.length > 0 ? kg.runQuery(`
              MATCH (n:Entity {projectId: $projectId})-[r:REL]-(m:Entity {projectId: $projectId})
              WHERE n.id IN $nodeIds AND NOT r.kind IN ['derived_from', 'applies_to', 'part_of']
              RETURN count(DISTINCT r) AS semanticEdges
            `, { projectId, nodeIds: nodeIdsArray }) : Promise.resolve([]),
            chapterId ? kg.runQuery(`
              MATCH (cf:Entity {type: 'continuity_finding'})-[:applies_to]->(c:Entity {type: 'chapter', label: $chapterLabel})
              RETURN cf.metadata AS metadata, cf.content AS message
            `, { chapterLabel }) : Promise.resolve([]),
            nodeIdsArray.length > 0 ? kg.runQuery(`
              MATCH (n:Entity {projectId: $projectId})-[r:REL]-(t:Entity {type: 'theme'})
              WHERE n.id IN $nodeIds AND r.kind IN ['has_theme', 'about']
              RETURN count(DISTINCT t) AS themeCount
            `, { projectId, nodeIds: nodeIdsArray }) : Promise.resolve([]),
          ]);

          const characterTraits = traitsRes.map((r) => ({
            id: r.get('id') as string,
            label: r.get('label') as string,
            content: r.get('content') as string,
            charId: r.get('charId') as string,
            charLabel: r.get('charLabel') as string,
          }));

          const characterSecrets = secretsRes.map((r) => ({
            id: r.get('id') as string,
            label: r.get('label') as string,
            content: r.get('content') as string,
            charId: r.get('charId') as string,
            charLabel: r.get('charLabel') as string,
            relKind: r.get('relKind') as string,
          }));

          const directChapterDegree = degreeRes.length > 0 ? Number(degreeRes[0].get('degree') || 0) : 0;
          const semanticEdgesCount = semanticRes.length > 0 ? Number(semanticRes[0].get('semanticEdges') || 0) : 0;

          metrics.directChapterDegree = directChapterDegree;
          metrics.semanticEdgesCount = semanticEdgesCount;

          if (!chapterNode) {
            blockers.push(`Non esiste ancora un nodo strutturale per Capitolo ${chapterNumber}.`);
            warnings.push(`Manca il nodo capitolo per il Capitolo ${chapterNumber}.`);
            score -= 10;
          }

          // Check direct degree threshold
          if (directChapterDegree < 15) {
            score -= 25;
            blockers.push(`Grado diretto del capitolo insufficiente (${directChapterDegree} < 15). Collega meglio il capitolo a eventi, scene e stati.`);
          } else if (directChapterDegree < 20) {
            score -= 10;
            warnings.push(`Grado diretto del capitolo basso (${directChapterDegree} < 20). Valuta connessioni aggiuntive.`);
          }

          // Check semantic edges threshold
          if (semanticEdgesCount < 40) {
            score -= 25;
            blockers.push(`Numero di relazioni semantiche non strutturali nel capitolo insufficiente (${semanticEdgesCount} < 40). Collega i nodi del capitolo a personaggi, temi e vincoli.`);
          } else if (semanticEdgesCount < 50) {
            score -= 10;
            warnings.push(`Numero di relazioni semantiche non strutturali basso (${semanticEdgesCount} < 50).`);
          }

          // Audit content using existing audit engine
          const audit = auditChapterContent({
            chapterNumber,
            content: draftContent,
            chapter: chapterNode,
            characters,
            styleRules,
            worldRules,
            themes,
            timelineEvents,
            characterTraits,
            characterSecrets,
          });

          // Process current audit findings
          for (const finding of audit.findings) {
            if (finding.severity === 'error') {
              score -= 20;
              blockers.push(`Errore audit [${finding.code}]: ${finding.message}`);
            } else if (finding.severity === 'warning') {
              score -= 10;
              warnings.push(`Warning audit [${finding.code}]: ${finding.message}`);
            }
          }

          // Process database continuity findings
          metrics.continuityFindingsCount = dbFindingsRes.length;
          for (const dbFinding of dbFindingsRes) {
            const meta = JSON.parse(String(dbFinding.get('metadata') || '{}'));
            const severity = String(meta.severity || '');
            const message = String(dbFinding.get('message') || '');
            const code = String(meta.code || '');
            if (severity === 'error') {
              score -= 20;
              blockers.push(`Errore di continuità DB [${code}]: ${message}`);
            } else if (severity === 'warning') {
              score -= 10;
              warnings.push(`Warning di continuità DB [${code}]: ${message}`);
            }
          }

          // Check character mentions/relations
          const mentionedCharacters = audit.detectedCharacters;
          metrics.characterCount = mentionedCharacters.length;
          if (mentionedCharacters.length === 0) {
            score -= 20;
            blockers.push('Nessun personaggio menzionato o collegato al capitolo.');
          }

          // Check themes linked
          const themeCount = themeCountRes.length > 0 ? Number(themeCountRes[0].get('themeCount') || 0) : 0;
          if (themeCount === 0) {
            score -= 15;
            blockers.push('Nessun tema narrativo collegato ai nodi di questo capitolo (relazioni has_theme/about mancanti).');
          }

          score = Math.max(0, Math.min(100, score));
          const eligible = score >= 90 && blockers.length === 0;

          return toolStructured({
            ok: true,
            eligible,
            score,
            metrics,
            blockers,
            warnings,
          });
        }
      } catch (err) {
        return toolError('NOVEL_VERIFY_INGESTION_THRESHOLD_FAILED', `novel_verify_ingestion_threshold failed: ${String(err)}`);
      }
    },
  );

  server.registerTool(
    'novel_get_coordination_prompt',
    {
      title: 'Novel get coordination prompt',
      description: 'Returns optimized coordination instructions for agents operating in EXECUTOR or VERIFIER roles during ingestion.',
      inputSchema: {
        role: z.enum(['executor', 'verifier', 'esecutore', 'verificatore']),
        type: z.enum(['bible_section', 'chapter_draft']),
        chapterNumber: z.number().int().positive().optional(),
        sourceId: z.string().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        prompt: z.string(),
        error: errorObj,
      },
      annotations: {
        title: 'Novel get coordination prompt',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ role, type, chapterNumber, sourceId }) => {
      try {
        const isExecutor = role === 'executor' || role === 'esecutore';
        const isBible = type === 'bible_section';

        let targetDetails = '';
        if (isBible) {
          targetDetails = sourceId ? `Source ID: ${sourceId}` : 'Source ID non specificato';
        } else {
          targetDetails = chapterNumber ? `Capitolo: ${chapterNumber}` : 'Numero Capitolo non specificato';
        }

        let prompt = '';

        if (isExecutor) {
          prompt = `=== RUOLO: ESECUTORE (AGENT PROMPT) ===
Obbiettivo: Preparare e arricchire l'ingestion per [${type.toUpperCase()}] (${targetDetails}) garantendo la conformità e la massima densità semantica del grafo neurale.

Istruzioni per l'Esecutore:
1. RICHIAMA IL CONTESTO ESISTENTE: Prima di proporre modifiche o scrivere testo, usa 'novel_recall_context' o 'kg_recall' per caricare personaggi, tratti psicologici, segreti, regole del mondo e vincoli narrativi.
2. CREA ASSOCIAZIONI E RELAZIONI SPECIFICHE: Evita di utilizzare la relazione generica 'related_to'. Associa i nodi usando archi semantici canonici (es. 'appears_in', 'changes_state', 'precedes', 'constrains', 'has_theme', 'about', 'sets_up'). Collega dinamiche relazionali a ENTRAMBI i personaggi partecipanti.
3. ESEGUI VERIFICA PRELIMINARE (DRY-RUN): Prima di considerare finito il lavoro, invoca 'novel_verify_ingestion_threshold' con dryRun/read-only per calcolare il punteggio di threshold e ottenere la lista dei blocker.
4. RISOLVI I BLOCKER:
   - Se ci sono duplicati canonical, esegui la deduplica/consolidamento.
   - Se mancano relazioni verso personaggi o temi, aggiungi archi 'appears_in' o 'has_theme'/'about'.
   - Se il linter rileva deviazioni di tratti psicologici ('character_trait_contradiction') o fughe di segreti ('secret_leak_detected'), modifica il contenuto della bozza per renderla coerente.
5. CONSEGNA: Quando il punteggio soddisfa la threshold (>= 90 per capitoli, >= 85 per la Bibbia) e non ci sono blocker, passa la palla al VERIFICATORE fornendo il payload completo e chiedendo la validazione ed il commit finale.`;
        } else {
          prompt = `=== RUOLO: VERIFICATORE (AGENT PROMPT) ===
Obbiettivo: Validare la bozza o l'estrazione proposta dall'Esecutore per [${type.toUpperCase()}] (${targetDetails}) prima del commit nel grafo neurale.

Istruzioni per il Verificatore:
1. EFFETTUA AUDIT COMPLETO: Esegui 'novel_verify_ingestion_threshold' per verificare il punteggio reale del modello e la presenza di blocker attivi. Esegui 'novel_audit_chapter' (se capitolo) o 'novel_bible_coverage_report' (se Bibbia) per raccogliere findings.
2. VALUTA CONTRASTI E COERENZA: Verifica se le nuove informazioni sono in contrasto con le regole globali del mondo, la timeline cronologica o i tratti/segreti esistenti dei personaggi (cerca relazioni di tipo 'contradicts' o warning nel linter).
3. PROCESSO DECISIONALE:
   - **FAIL (Respingi)**: Se il punteggio di threshold è inferiore al target (90 per capitoli, 85 per la Bibbia) o se sono presenti blocker/errori attivi:
     - Genera un report dettagliato specificando i codici errore (es. 'character_trait_contradiction', 'missing_theme_nodes', 'pending_edge_candidates_missing_endpoints').
     - Ripassa la palla all'Esecutore indicando le modifiche necessarie per superare il gate.
   - **PASS (Approva)**: Se non ci sono blocker, la densità semantica è ottimale, e il punteggio è soddisfatto:
     - Procedi all'ingestion finale invocando 'novel_commit_bible_candidates' (per la Bibbia) o finalizzando la bozza tramite il tool di save/assemble per i capitoli.
     - Fornisci conferma scritta dell'avvenuta scrittura con statistiche finali del grafo (nodi scritti, archi creati).`;
        }

        return toolStructured({
          ok: true,
          prompt,
        });
      } catch (err) {
        return toolError('NOVEL_GET_COORDINATION_PROMPT_FAILED', `novel_get_coordination_prompt failed: ${String(err)}`);
      }
    },
  );
}
