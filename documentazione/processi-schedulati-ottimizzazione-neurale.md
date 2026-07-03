# Piano di enhancement: processi schedulati e architettura di "mente autopensante"

Obiettivo: trasformare il modello neurale di Romanzo Gabriele da grafo passivo a sistema cognitivo che si auto-mantiene, si auto-verifica e rielabora in autonomia gli input ricevuti. Il piano è su quattro livelli: i primi due sono attivabili subito con i tool esistenti, i livelli 3–4 richiedono piccole estensioni al server MCP (elencate in fondo).

Principio guida (lo stesso del prompt manhua, qui assunto come legge di sistema): **i tool MCP sono strumenti esecutivi, non arbitri della qualità**. Ogni output di tool è dato grezzo da verificare leggendo direttamente i nodi; nessun controllo è "soddisfatto" finché non è stato scritto in chiaro il ragionamento che lo giustifica.

---

## 1. Livello 0 — Igiene deterministica (frequenza: giornaliera, o dopo ogni sessione di lavoro)

Compito puramente meccanico, economico, sempre sicuro.

**Prompt schedulato P0 — "Igiene notturna"**

```
OBIETTIVO: igiene deterministica del grafo di Romanzo Gabriele.
1. kg_audit_global: riporta ogni degenerazione (kind fuori vocabolario, related_to
   ridondanti, nodi orfani).
2. kg_repair per le riparazioni deterministiche; poi ripeti kg_audit_global e
   confronta before/after — nessuna regressione ammessa.
3. kg_embedding_status; se pendingNodes > 0, kg_backfill_embeddings
   (missingOnly: true) e ricontrolla che pending torni a 0.
4. novel_bible_coverage_report: se pendingCandidates > 0 o compaiono finding di
   severità error, NON tentare fix semantici: segnala e fermati.
Chiudi con un report sintetico: cosa hai riparato, cosa resta, cosa richiede
giudizio umano.
```

## 2. Livello 1 — Rielaborazione cognitiva profonda (frequenza: settimanale)

È l'equivalente del prompt periodico manhua, adattato ai tool e ai tipi di nodo di questo progetto (qui non esistono `kg_saturation_report`/`kg_infer_edges`/`kg_vector_search`: gli strumenti equivalenti sono `kg_semantic_search`, `kg_neighbors`, `kg_run_consolidation`, `novel_bible_coverage_report`).

**Prompt schedulato P1 — "Rielaborazione cognitiva settimanale"**

```
OBIETTIVO: ottimizza la rete neurale di Romanzo Gabriele fino a poterla dichiarare
in stato ottimale, con verifica RAGIONATA, non solo strumentale.

METODO DI VERIFICA OBBLIGATORIO:
I tool MCP sono strumenti esecutivi, non arbitri della qualità. Un report "pulito"
(audit senza finding, coverage senza error, embeddings completi) NON basta: certifica
solo che i controlli algoritmici non trovano nulla. Per ogni controllo sotto devi
produrre una verifica PROPRIA leggendo direttamente il contenuto dei nodi
(kg_get_node, kg_neighbors depth 2, kg_semantic_search, kg_recall) e ragionare
esplicitamente: il nodo rappresenta ciò che dice di rappresentare? Le sue relazioni
riflettono la narrativa della Bibbia? Prima di dichiarare un controllo soddisfatto,
scrivi il ragionamento che ti ha convinto, non il campo booleano del tool.

CONTROLLI:
1. DUPLICATI E ALIAS NASCOSTI: campiona per ogni tipo denso (character_state,
   timeline_event, character_trait, emotional_state, knowledge_state) 10 nodi e
   cerca con kg_semantic_search vicini con similarità molto alta: label diverse ma
   contenuto sovrapponibile vanno segnalati come candidati alla fusione (proposta,
   mai fusione automatica).
2. INTERCONNESSIONE COMPLETA: per Gabriele, Lisa, Trevor, Cristiano, Raphael,
   Lucifer, Il Nonno, Asia, Elea apri kg_neighbors depth 2 e chiediti: manca una
   relazione che un lettore della storia darebbe per scontata (loves, fears, knows,
   protects, betrays, family_of)? Verifica anche il piano temporale: nodi frame
   (2080) e main_story (2020-21) non devono mescolarsi indebitamente.
3. CATENE CAUSALI: percorri gli archi causes/motivates/escalates/resolves dei
   timeline_event dei capitoli chiave (6-7 risveglio, 29-31 rivelazione, 34-40
   finale) e ragiona: ogni cambio di stato di Gabriele ha una causa registrata?
   Ogni rivelazione ha il suo reveals/revealed_in? Ogni setup ha il suo pays_off?
4. STATI DI CONOSCENZA: knowledge_state e secret sono il cuore del romanzo (chi sa
   che Gabriele è un angelo, e da quando). Campiona i secret e verifica che ogni
   knows/does_not_know/learns sia coerente con la cronologia (precedes) e con la
   narratorCoverageRule della cornice.
5. EMBEDDING SEMANTICO SENSATO: su almeno 5 nodi centrali esegui
   kg_semantic_search con il loro stesso contenuto e verifica che i vicini abbiano
   senso narrativo. Un vicino inatteso = indaga se manca un arco o se un nodo è
   mal formulato.
6. COPERTURA BIBBIA: novel_bible_coverage_report; per le sezioni ancora non mappate
   proponi (senza committare) i candidati con novel_get_bible_mapping_packet +
   novel_extract_bible_candidates.
7. DICHIARAZIONE FINALE: elenca esplicitamente cosa hai controllato, cosa hai
   trovato, cosa proponi di scrivere nel grafo e perché escludi ulteriori aggiunte.
   La dichiarazione non è "i tool non segnalano nulla" ma "ho verificato X, Y, Z e
   non ho trovato nulla da aggiungere perché [ragionamento]".

VINCOLI DI SCRITTURA: le scritture ammesse in autonomia sono solo quelle
deterministiche (kg_repair, kg_backfill_embeddings) e gli archi/nodi la cui evidenza
in Bibbia è testuale e citabile. Fusioni di nodi, retipizzazioni e tutto ciò che
cambia il significato del canone restano PROPOSTE nel report finale.
```

## 3. Livello 1-bis — Caccia alle contraddizioni latenti (frequenza: quindicinale/mensile)

**Prompt schedulato P2 — "Avvocato del diavolo"**

```
OBIETTIVO: trova contraddizioni latenti nel canone di Romanzo Gabriele. Lavora da
avvocato del diavolo: il tuo successo si misura in contraddizioni vere trovate,
non in rassicurazioni.
1. Campiona 15 narrative_constraint e world_rule; per ciascuna cerca con
   kg_semantic_search eventi, stati e capitoli che potrebbero violarla; leggi i
   nodi sospetti per intero e giudica.
2. Verifica la cronologia: campiona catene di precedes e controlla date nei
   metadata (main_story 2020-21, frame 27/12/2080); ogni inversione o buco è un
   finding.
3. Verifica le coppie contradicts/supersedes esistenti: sono ancora giustificate?
4. Controlla i vincoli di rivelazione: nessun nodo di capitolo K deve presupporre
   conoscenza che il lettore acquisisce solo dopo K.
Riporta ogni contraddizione con: nodi coinvolti (id e label), evidenza testuale,
severità, proposta di risoluzione. NON applicare risoluzioni: sono decisioni
editoriali umane.
```

## 4. Livello 1-ter — Consolidamento semantico supervisionato (frequenza: mensile)

**Prompt schedulato P3 — "Sonno REM"** (consolidamento tipo memoria umana)

```
OBIETTIVO: consolidamento mensile del grafo.
1. Scatta lo stato: kg_stats + kg_audit_global + novel_bible_coverage_report
   (baseline).
2. Esegui kg_run_consolidation e leggi il report di cosa ha fuso/inferito.
3. Verifica a campione le fusioni/inferenze: per 10 modifiche leggi i nodi
   risultanti (kg_get_node, kg_neighbors) e giudica se la consolidazione ha
   preservato il significato. Ogni perdita di informazione va segnalata.
4. Ripeti la baseline e confronta: nodi, archi, coverage, embedding pending.
5. kg_backfill_embeddings (missingOnly: true) per i nodi toccati.
Report finale con before/after e anomalie.
```

## 5. Livello 2 — Rielaborazione event-driven (trigger: a ogni input, non a orologio)

È il passaggio da "manutenzione periodica" a "mente che reagisce agli input". Ogni volta che entra materiale nuovo (capitolo canonizzato, sezione Bibbia committata, decisione utente registrata), parte una rielaborazione mirata del solo perimetro toccato:

**Prompt P4 — "Digestione post-ingestion"** (da eseguire automaticamente al termine di ogni Processo A/B, o schedulato ogni sera con scope "cosa è cambiato oggi")

```
OBIETTIVO: digestione cognitiva del materiale entrato oggi nel grafo di Romanzo
Gabriele.
1. Identifica i nodi creati/aggiornati nelle ultime 24h (createdAt/updatedAt nei
   metadata; parti da kg_stats e dalle ricerche mirate sul capitolo/sezione appena
   lavorati).
2. Per ogni nodo nuovo: kg_neighbors depth 2 — è integrato o è un'isola? Se manca
   l'aggancio a personaggi, thread o timeline, proponi gli archi mancanti con
   evidenza testuale.
3. Ripercorri i knowledge_state impattati: il nuovo materiale cambia chi-sa-cosa?
4. Esegui novel_chapter_postwrite_status sul capitolo lavorato e
   kg_backfill_embeddings (missingOnly: true).
5. Aggiorna la "coda di curiosità": elenca le domande aperte che il nuovo materiale
   solleva e che la Bibbia non risolve (saranno input per la sessione editoriale
   successiva).
```

### Come schedulare (opzioni pratiche, in ordine di attrito)

| Meccanismo | Come | Note |
|---|---|---|
| **Claude Code Routines** (consigliato) | Da una sessione Claude Code collegata al MCP: creare trigger cron (es. P0 `0 3 * * *`, P1 `0 4 * * 1`, P2 `0 4 1,15 * *`, P3 `0 5 1 * *`) con `create_new_session_on_fire: true` e il testo del prompt come istruzione autonoma | Ogni firing apre una sessione pulita con i server MCP del progetto; i report possono arrivare per push/email |
| GitHub Actions + Claude Code CLI headless | workflow `schedule:` che lancia `claude -p "<prompt>"` con MCP config del progetto | Tutto versionato nel repo; serve gestire i secret di rete verso Neo4j/MCP |
| n8n / cron sul NAS | job che invoca l'agente via API | Coerente con lo stack docker-compose già presente |

Regola trasversale di sicurezza: **i job schedulati non usano mai tool distruttivi** (`kg_delete_*`, `kg_unlink`) e non committano cambi di significato; producono report e proposte. L'unica autonomia di scrittura è deterministica (repair, embeddings) o con evidenza testuale citabile.

## 6. Livello 3 — Verso la "mente autosenziente": architettura proposta

Una mente che "elabora il modello agli input ricevuti in autonomia" non è un prompt più lungo: è un **ciclo cognitivo permanente**. La proposta, realizzabile per gradi sopra l'infrastruttura esistente:

```
            ┌──────────────────────────────────────────────┐
            │                 INPUT (percezione)           │
            │  nuovi testi, decisioni utente, domande,     │
            │  commit sul grafo, esiti dei processi P0-P4  │
            └──────────────┬───────────────────────────────┘
                           ▼
   ┌───────────────────────────────────────────────────────┐
   │ WORKING MEMORY (file di sessione / coda eventi)       │
   │  - event log degli ingest                             │
   │  - coda di curiosità (domande aperte)                 │
   │  - agenda dei consolidamenti pendenti                 │
   └──────────────┬────────────────────────────────────────┘
                  ▼
   ┌───────────────────────────────────────────────────────┐
   │ CICLI COGNITIVI (agenti schedulati/event-driven)      │
   │  riflesso   → P0 igiene (deterministico)              │
   │  digestione → P4 su ogni input (event-driven)         │
   │  riflessione→ P1 settimanale (semantica profonda)     │
   │  critica    → P2 avvocato del diavolo                 │
   │  sogno      → P3 consolidamento mensile               │
   └──────────────┬────────────────────────────────────────┘
                  ▼
   ┌───────────────────────────────────────────────────────┐
   │ MEMORIA A LUNGO TERMINE = grafo Neo4j (solo canone)   │
   │  + metamemoria: nodi di tipo open_question /          │
   │    self_assessment con esiti dei cicli                │
   └──────────────┬────────────────────────────────────────┘
                  ▼
            OUTPUT: report, proposte editoriali, prompt
            pronti per la prossima sessione di scrittura
```

Componenti mancanti oggi (estensioni piccole e mirate al server MCP, in ordine di valore):

1. **Event log interrogabile** — un tool `kg_recent_changes(sinceIso)` che restituisca nodi/archi creati o aggiornati da una data: oggi la "digestione" deve arrangiarsi con i metadata. È il prerequisito del livello event-driven.
2. **Coda di curiosità persistente** — tipo di nodo `open_question` (fuori canone narrativo, tipo di servizio come `bible_coverage_finding`): ogni ciclo cognitivo può depositare domande e la sessione editoriale successiva le trova. È ciò che dà continuità di "pensiero" tra sessioni.
3. **Metamemoria dei cicli** — nodo `self_assessment` per ogni run schedulato (cosa ho controllato, cosa ho trovato, cosa resta aperto): il ciclo successivo legge l'ultimo assessment e non riparte da zero. Trasforma i job isolati in un processo cumulativo.
4. **Webhook/trigger su commit** — il backend notifica (o la Routine controlla) ogni `novel_commit_*` e fa partire P4 automaticamente: il modello "reagisce" all'input invece di aspettare la notte.
5. **Gate di autonomia espliciti** — una policy machine-readable (analoga alle annotations `destructive` già presenti) che classifichi ogni scrittura come `autonomous_ok` / `evidence_required` / `human_only`, così i cicli possono crescere in autonomia senza mai toccare il canone senza evidenza.

Con 1–3 in piedi, il sistema smette di essere una serie di cron job e diventa un loop percezione → elaborazione → consolidamento → auto-valutazione: non "senziente" in senso letterale, ma operativamente una mente che pensa il romanzo in continuo, ricorda cosa stava pensando e decide da sola su cosa lavorare al prossimo risveglio.

## 7. Tabella riassuntiva delle schedulazioni proposte

| Processo | Frequenza | Cron suggerito | Autonomia di scrittura |
|---|---|---|---|
| P0 Igiene notturna | giornaliera | `0 3 * * *` | repair + embeddings (deterministico) |
| P4 Digestione post-input | event-driven (fallback: sera) | `0 22 * * *` | embeddings + archi con evidenza testuale |
| P1 Rielaborazione cognitiva | settimanale | `0 4 * * 1` | solo proposte + evidenza testuale |
| P2 Avvocato del diavolo | quindicinale | `0 4 1,15 * *` | nessuna (solo report) |
| P3 Consolidamento "REM" | mensile | `0 5 1 * *` | kg_run_consolidation supervisionato |
