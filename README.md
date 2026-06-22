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
- `romanzo_gabriele_watchtower`

Il server MCP puo essere esposto separatamente tramite `MCP_HOST_PORT` per i connector IA.

## Flusso Narrativo

1. Importare l'indice della Bibbia come struttura, senza trasformarlo in contenuto canonico dettagliato.
2. Importare la Bibbia completa a sezioni preservando testo, heading, path, ordine, hash e provenance.
3. Generare candidati semantici, validarli e committarli solo con evidence verso `bible_section`.
4. Controllare la copertura della Bibbia prima di usare il grafo per editing o scrittura.
5. Importare bozze reali dei capitoli come materiale di lavoro.
6. Prima di scrivere o revisionare, richiamare il context packet del capitolo.
7. Salvare gli output degli step editoriali come lavoro operativo, non come canone.

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
# modificare NEO4J_PASSWORD, MCP_SHARED_SECRET, NAS_PROJECT_PATH e porte host
docker compose up -d --build
```

Il frontend viene servito da `FE_HOST_PORT`; il backend legge Neo4j in sola lettura per la UI; il server MCP scrive nel grafo tramite strumenti controllati.

## Tool MCP

Tool generici mantenuti:

- Nodi: `kg_add_node`, `kg_upsert_node`, `kg_upsert_nodes`, `kg_update_node`, `kg_delete_node`
- Archi: `kg_link`, `kg_link_bulk`, `kg_unlink`
- Asset: `kg_attach_asset`
- Retrieval: `kg_get_node`, `kg_search`, `kg_neighbors`, `kg_recall`, `kg_stats`
- Manutenzione: `kg_audit_global`, `kg_repair`
- Documenti: `kg_ingest_document`, `kg_get_document_chunks`, `kg_list_documents`

Tool narrativi disponibili:

- `novel_ingest_outline`: importa solo struttura dell'indice.
- `novel_ingest_bible`: conserva la Bibbia completa quando fornita.
- `novel_ingest_bible_sections`: importa sezioni Bibbia gia estratte dal DOCX.
- `novel_extract_bible_candidates`: genera candidati semantici non canonici.
- `novel_commit_bible_candidates`: committa candidati validati con evidence obbligatoria.
- `novel_bible_coverage_report`: segnala sezioni non mappate, candidati pendenti, nodi senza fonte e relazioni generiche.
- `novel_get_chapter_context_packet`: prepara il pacchetto contesto per capitolo e step editoriale.
- `novel_ingest_chapter_draft`: salva bozze reali di capitolo.
- `novel_recall_context`: prepara contesto narrativo per scrittura/revisione.
- `novel_audit_chapter`: controlla rischi di coerenza senza modificare il grafo.

Tool workflow editoriale:

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
