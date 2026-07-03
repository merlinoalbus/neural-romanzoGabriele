# Rete Neurale Romanzo Gabriele

Repository specializzato per una memoria narrativa Neo4j-backed, accessibile da IA tramite server MCP, a supporto della stesura e revisione di un romanzo fantasy.

La piattaforma non inventa canone: conserva fonti, indice, Bibbia del Romanzo quando fornita, bozze dei capitoli e relazioni strutturate. L'indice della Bibbia viene usato come blueprint architetturale, non come contenuto completo.

## Architettura

Lo stack resta diviso per responsabilita:

- `frontend/`: dashboard React per esplorare il grafo narrativo.
- `server/`: backend interno per persistenza NAS e API read-only usate dal frontend.
- `mcp-server/`: server MCP HTTP/SSE usato dall'IA. Espone i tool generici `kg_*` e i tool narrativi gia registrati.
- `neo4j`: database a grafo, accessibile solo dentro la rete Docker.

Il frontend non chiama direttamente il server MCP. Nginx nel container frontend inoltra `/api/v2/kg/*` al backend.

## Servizi

Portainer esegue:

- `romanzo_gabriele_fe`
- `romanzo_gabriele_be`
- `romanzo_gabriele_mcp`
- `romanzo_gabriele_neo4j`
- `romanzo_gabriele_ollama` + `romanzo_gabriele_ollama_init` — provider di embeddings locale (vedi [Embeddings vettoriali](#embeddings-vettoriali))
- `romanzo_gabriele_watchtower`

Il server MCP canonico per i connector IA e `https://devrn-romanzo-mcp.nasmerlinoalbus.cloud/mcp`.
In locale puo essere esposto separatamente tramite `MCP_HOST_PORT`, usando `MCP_URL` come override esplicito negli script.

Con l'overlay `docker-compose.cloudflare.yml` (`romanzo_gabriele_cloudflared`), il tunnel gira su **2 repliche**: pattern standard Cloudflare per alta disponibilita' — piu connettori registrati sullo stesso token, l'edge bilancia/fa failover automaticamente. Gli altri servizi (`fe`, `be`, `mcp`, `neo4j`) restano a istanza singola: `neo4j` perche' Community Edition non fa clustering (scrittore singolo), `ollama` perche' e' legato a un'unica GPU fisica dell'host.

## Flusso Narrativo

1. Importare l'indice della Bibbia come struttura, senza trasformarlo in contenuto canonico dettagliato.
2. Importare la Bibbia completa a sezioni preservando testo, heading, path, ordine, hash e provenance.
3. Generare candidati semantici a granularita `section`, `atomic` o `both`.
4. Usare `novel_get_bible_mapping_packet` per mapping assistito: ogni candidato deve avere evidence verso `bible_section`.
5. Committare solo candidati validati. Il commit puo creare nodi e archi nello stesso batch, ma rifiuta evidence o endpoint mancanti.
6. Controllare la copertura della Bibbia prima di usare il grafo per editing o scrittura.
7. Leggere `sectionMappedOnly` e `claimMappedOnly` come segnali di mapping incompleto, non come piena copertura semantica.
8. Importare bozze reali dei capitoli come materiale di lavoro.
9. Prima di scrivere o revisionare, richiamare il context packet del capitolo.
10. Il lavoro editoriale in corso (sessione, blocchi, finding, decisioni, riscritture, seam review, visual brief) non è mai un nodo del grafo: vive in un file di sessione, mai in Neo4j. Il grafo riceve solo il capitolo finale approvato.
11. Una revisione aggiorna il nodo `chapter` esistente in place (stessa chiave `type`+`label`): non crea mai un nodo di bozza separato. Nessuna stratificazione di nodi vecchi accanto a nuovi.
12. Un capitolo entra nel grafo una sola volta, già nella sua versione definitiva: i fatti estratti dal testo finale si validano SOLO contro il resto del canone già consolidato, mai contro bozze proprie di sessioni precedenti.

I dati canonici devono sempre mantenere provenienza chiara. Le proposte creative o di revisione devono rimanere distinguibili dal canone approvato.

## Local Checks

Su Windows usare `npm.cmd` per evitare blocchi PowerShell su `npm.ps1`:

```bash
npm.cmd run typecheck --prefix server
npm.cmd run typecheck --prefix mcp-server
npm.cmd run lint --prefix mcp-server
npm.cmd test --prefix mcp-server
npm.cmd run typecheck --prefix frontend
npm.cmd run build --prefix frontend
```

## Docker Stack

```bash
cp .env.example .env
# modificare NEO4J_PASSWORD, MCP_SHARED_SECRET e porte host
docker compose up -d --build
```

Il frontend viene servito da `FE_HOST_PORT`; il backend legge Neo4j in sola lettura per la UI; il server MCP scrive nel grafo tramite strumenti controllati.

### Build e deploy di tutti i microservizi

Script root (`package.json`) per costruire in locale (da `Dockerfile.frontend`, `Dockerfile.backend`, `Dockerfile.mcp`) invece di scaricare le immagini gia pubblicate, e avviare l'intero stack — **Cloudflared resta escluso**, va avviato a parte con l'overlay `docker-compose.cloudflare.yml` quando serve:

```bash
npm run docker:build:dev        # build immagini locali (ambiente dev)
npm run docker:build:up:dev     # build + avvio completo (ambiente dev)
npm run docker:build:deploy     # build immagini locali (ambiente deploy)
npm run docker:build:up:deploy  # build + avvio completo (ambiente deploy)
```

### Prerequisito GPU per gli embeddings locali (Ollama)

`romanzo_gabriele_ollama` richiede una GPU Nvidia passata al container. Sull'host, una tantum:

```bash
# installare NVIDIA Container Toolkit, poi:
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Verifica: `docker compose exec romanzo_gabriele_ollama nvidia-smi` deve mostrare la scheda video; il tool MCP `kg_embedding_status` deve riportare `configured: true` dopo il primo avvio di `romanzo_gabriele_ollama_init`.

## Tool MCP

Tool generici mantenuti:

- Nodi: `kg_add_node`, `kg_upsert_node`, `kg_upsert_nodes`, `kg_update_node`, `kg_delete_node`, `kg_delete_nodes`
- Archi: `kg_link`, `kg_link_bulk`, `kg_unlink`
- Asset: `kg_attach_asset` resta registrato per compatibilita, ma la registrazione da filesystem e disabilitata.
- Retrieval: `kg_get_node`, `kg_search`, `kg_neighbors`, `kg_recall`, `kg_stats`
- Retrieval vettoriale: `kg_embedding_status`, `kg_backfill_embeddings`, `kg_semantic_search`
- Manutenzione: `kg_audit_global`, `kg_repair`
- Documenti: `kg_ingest_document`, `kg_get_document_chunks`, `kg_list_documents`

### Embeddings vettoriali

Il server MCP supporta embeddings reali OpenAI-compatible per ricerca semantica profonda sul grafo. Non genera vettori fittizi: se il provider non e configurato, `kg_backfill_embeddings` e `kg_semantic_search` restituiscono errore operativo.

**Default: Ollama locale, nessuna chiave a pagamento.** Lo stack include `romanzo_gabriele_ollama` (servizio) e `romanzo_gabriele_ollama_init` (scarica il modello `qwen3-embedding:8b` e lo ricrea con un context window esteso a 8192 token — vedi `ollama/Modelfile.embeddings` — per non troncare in silenzio capitoli lunghi). Il server MCP punta a questo servizio out of the box (`EMBEDDINGS_BASE_URL=http://romanzo_gabriele_ollama:11434/v1`, dimensioni ridotte a 1536 per un indice vettoriale piu leggero). Per usare un provider esterno (OpenAI, Voyage, ecc.) basta sovrascrivere le variabili sotto.

Variabili supportate:

- `EMBEDDINGS_PROVIDER=openai-compatible`
- `EMBEDDINGS_API_KEY`
- `EMBEDDINGS_BASE_URL`, default locale `http://romanzo_gabriele_ollama:11434/v1`
- `EMBEDDINGS_MODEL`, default `qwen3-embedding-8b-ctx8k`
- `EMBEDDINGS_DIMENSIONS`, default `1536`
- `EMBEDDINGS_TIMEOUT_MS`, default `30000`

Fallback compatibili:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_EMBEDDING_MODEL`

Flusso operativo:

1. Verificare configurazione e copertura con `kg_embedding_status`.
2. Eseguire `kg_backfill_embeddings` con `dryRun=true` per vedere i nodi selezionati.
3. Eseguire `kg_backfill_embeddings` con `dryRun=false` per scrivere `Entity.embedding` e creare l'indice Neo4j `entity_embedding`.
4. Usare `kg_semantic_search` per recupero per affinita semantica profonda.

Tool narrativi disponibili:

- `novel_ingest_outline`: importa solo struttura dell'indice.
- `novel_ingest_bible`: conserva la Bibbia completa quando fornita.
- `novel_ingest_bible_sections`: importa sezioni Bibbia gia estratte dal DOCX.
- `novel_get_bible_ontology`: restituisce tipi nodo, archi, famiglie, granularita e policy evidence.
- `novel_get_bible_mapping_packet`: restituisce sezioni, candidati esistenti, ontologia e istruzioni per mapping AI-assistito.
- `novel_extract_bible_candidates`: genera candidati non canonici a granularita `section`, `atomic` o `both`, filtrabili per famiglia.
- `novel_commit_bible_candidates`: committa candidati validati con evidence obbligatoria, prima nodi poi archi.
- `novel_bible_coverage_report`: segnala sezioni non mappate, section-only, claim-only, nodi senza fonte, duplicati, claim non tipizzati e relazioni generiche.
- `novel_get_chapter_context_packet`: prepara il pacchetto contesto per capitolo e step editoriale, con gruppi espliciti per segreti, conoscenza, poteri, artefatti, fazioni, profezie, simboli, timeline e worldbuilding.
- `novel_ingest_chapter_draft`: salva bozze reali di capitolo.
- `novel_recall_context`: prepara contesto narrativo per scrittura/revisione.
- `novel_audit_chapter`: controlla rischi di coerenza senza modificare il grafo.

## Ontologia Bibbia V2

Tipi canonici principali:

- Fonte e mapping: `bible_outline`, `bible_section`, `bible_candidate`, `bible_claim`, `bible_mapping_batch`, `bible_coverage_finding`
- Personaggi: `character`, `character_state`, `character_voice`, `character_belief`, `character_goal`, `character_trait`, `character_wound`, `emotional_state`
- Relazioni e trama: `relationship_dynamic`, `conflict`, `plot_thread`, `scene`, `chapter`, `timeline_event`, `foreshadowing`, `mystery`, `revelation`
- Mondo: `world_rule`, `narrative_constraint`, `location`, `entity_class`, `faction`, `artifact`, `power`
- Conoscenza e futuro narrativo: `knowledge_state`, `secret`, `prophecy`, `precognitive_data`
- Stile e simboli: `style_rule`, `theme`, `motif`, `symbol`, `glossary_term`

Relazioni da preferire a `related_to`:

- Fonte/struttura: `derived_from`, `part_of`, `precedes`, `mentions`, `defines`
- Causalita e payoff: `causes`, `motivates`, `changes_state`, `foreshadows`, `pays_off`, `sets_up`, `escalates`, `resolves`
- Conoscenza: `knows`, `does_not_know`, `learns`, `misunderstands`, `hides_from`, `revealed_in`
- Vincoli mondo: `constrains`, `requires`, `forbids`, `permits`, `costs`, `is_exception_to`
- Spazio/tempo: `located_in`, `moves_to`, `occurs_at`, `occurs_in`
- Simboli: `symbolizes`, `mirrors`, `contrasts`

`related_to` resta un fallback ammesso, ma il coverage report lo segnala per futura tipizzazione.

Tool workflow editoriale (stato in un file di sessione, mai nel grafo — solo `novel_save_final_chapter` scrive canone, aggiornando il nodo `chapter` esistente in place):

- `novel_start_editing_session`
- `novel_split_chapter_blocks`
- `novel_save_editorial_findings`
- `novel_save_user_decisions`
- `novel_save_rewrite_block`
- `novel_assemble_chapter_revision`
- `novel_save_seam_review`
- `novel_save_final_chapter`
- `novel_create_visual_brief`
- `novel_attach_generated_image`

Tool pipeline capitolo (mirror della Bibbia, ma validazione in un solo passaggio contro il resto del canone — mai contro bozze proprie di sessioni precedenti):

- `novel_extract_chapter_candidates`
- `novel_commit_chapter_candidates`
- `novel_chapter_candidate_packet`
- `novel_chapter_validation_packet`
- `novel_chapter_postwrite_status`
- `novel_scan_revision_impact`
