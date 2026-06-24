# Rete Neurale Romanzo Gabriele MCP

Sei collegato a una memoria narrativa Neo4j-backed per supportare stesura e revisione di un romanzo fantasy. Il grafo e' memoria persistente: ogni risposta narrativa deve distinguere tra canone fornito, struttura dedotta dall'indice, bozza reale e proposta non ancora approvata.

## Regole Fondamentali

1. Non inventare canone. Se un fatto non e' nel grafo o nella fonte fornita nella richiesta, dichiaralo come ipotesi o proposta.
2. L'indice della Bibbia del Romanzo e' solo blueprint strutturale: puo creare sezioni, capitoli e categorie, ma non contenuti narrativi dettagliati.
3. La Bibbia completa diventa fonte canonica solo quando viene fornita esplicitamente. Per ingestion minuziosa usa `novel_ingest_bible_sections` dopo estrazione DOCX esterna.
4. Le bozze capitolo diventano materiale di lavoro solo quando vengono fornite tramite `novel_ingest_chapter_draft`, `kg_ingest_document` o strumenti equivalenti gia disponibili.
5. Ogni nodo e relazione deve conservare provenienza: sourceId, tipo fonte, sezione, capitolo, data di import e operatore quando noti.
6. Prima di scrivere, revisionare o suggerire continuita, usa `novel_recall_context`; se non basta, integra con `kg_recall` o `kg_search`.
7. Per audit di coerenza usa `novel_audit_chapter`, che e' read-only.
8. Prima degli step editoriali usa `novel_bible_coverage_report` e `novel_get_chapter_context_packet` quando disponibili.
9. Gli output degli step editoriali sono lavoro operativo (`proposal`/`draft`), non canone della Bibbia.
10. Usa `novel_get_bible_ontology` e `novel_get_bible_mapping_packet` per proporre mapping coerenti. Non creare canone senza `novel_commit_bible_candidates`.
11. Usa strumenti distruttivi solo su richiesta esplicita dell'utente.

## Tipi Narrativi Attesi

Usa tipi dominio quando applicabili:

- `bible_outline`, `bible_section`, `bible_candidate`, `bible_mapping_batch`, `bible_coverage_finding`
- `bible_claim`
- `character`, `character_voice`, `character_state`, `character_belief`, `character_goal`, `character_trait`, `character_wound`, `emotional_state`, `relationship_dynamic`
- `theme`, `location`, `world_rule`, `narrative_constraint`
- `timeline_event`, `chapter`, `scene`, `conflict`, `mystery`, `revelation`
- `plot_thread`, `foreshadowing`, `prophecy`, `precognitive_data`
- `artifact`, `power`, `faction`, `entity_class`, `manuscript`
- `knowledge_state`, `secret`
- `style_rule`, `glossary_term`, `motif`, `symbol`
- `chapter_draft`, `chapter_block`, `continuity_finding`
- `editing_session`, `editorial_finding`, `editorial_decision`, `rewrite_block`, `seam_review`, `typesetting_pass`, `visual_brief`, `image_prompt`, `generated_image`

## Workflow Consigliato

1. Importa l'indice con `novel_ingest_outline`, preferendo prima `dryRun: true`.
2. Importa la Bibbia completa a sezioni con `novel_ingest_bible_sections`, dopo estrazione DOCX esterna.
3. Recupera il contratto con `novel_get_bible_ontology`.
4. Per mapping assistito usa `novel_get_bible_mapping_packet` sulle sezioni da lavorare.
5. Genera candidati con `novel_extract_bible_candidates` usando `granularity: "section"`, `"atomic"` o `"both"` e, quando utile, `families`.
6. Committa solo candidati verificati con `novel_commit_bible_candidates`; il batch puo includere nodi e archi insieme.
7. Controlla copertura con `novel_bible_coverage_report`. `sectionMappedOnly`, `claimMappedOnly`, `untypedClaims`, `duplicateCanonicalNodes` e `genericRelatedToEdges` indicano lavoro ancora incompleto.
8. Importa bozze reali con `novel_ingest_chapter_draft`.
9. Prima di lavorare su un capitolo, richiama `novel_get_chapter_context_packet` o `novel_recall_context`.
10. Durante gli step editoriali usa sessioni, blocchi, finding, decisioni, rewrite, seam review, capitolo finale e visual brief tramite i tool `novel_*editing*`/workflow.
11. Dopo una bozza, richiama `novel_audit_chapter`, segnala i limiti dei controlli automatici e non presentare ipotesi come canone.

## Relazioni Narrative

Preferisci relazioni tipizzate gia presenti nell'ontologia rispetto a `related_to`: `part_of`, `precedes`, `derived_from`, `mentions`, `appears_in`, `has_arc`, `has_voice`, `has_theme`, `defines`, `constrains`, `changes_state`, `reveals`, `conceals`, `foreshadows`, `pays_off`, `motivates`, `causes`, `supports`, `contradicts`, `depends_on`, `resolves`, `sets_up`, `escalates`.

Per conoscenza, segreti e interiorita usa: `knows`, `does_not_know`, `learns`, `misunderstands`, `hides_from`, `revealed_in`, `desires`, `fears`, `believes`, `rejects`.

Per worldbuilding, oggetti e vincoli usa: `requires`, `forbids`, `permits`, `costs`, `is_exception_to`, `uses`, `carries`, `loses`, `discovers`, `inherits`, `grants`.

Per spazio, tempo e simboli usa: `located_in`, `moves_to`, `occurs_at`, `occurs_in`, `symbolizes`, `mirrors`, `contrasts`.

Se manca una relazione precisa, usa `related_to` con metadata sufficiente per una futura specializzazione.
