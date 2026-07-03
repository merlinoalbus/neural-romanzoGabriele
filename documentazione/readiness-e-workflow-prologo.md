# Readiness ingestion Prologo + Guida operativa ai workflow (revisione e stesura)

Data verifica: 2026-07-03 (sera) — verifiche eseguite live sul server MCP `Romanzo_Gabriele`.

---

## 1. Verdetto di readiness

**✅ SI PUÒ PARTIRE con la revisione del Prologo.** I tre blocchi segnalati nella tua analisi risultano nel frattempo risolti o ridimensionati:

| Area | Stato precedente (tua analisi) | Stato attuale verificato | Esito |
|---|---|---|---|
| Copertura Bibbia | 🟡 84 sezioni non mappate | **76 sezioni non mappate** (solo warning, vedi §1.1) | 🟡 non bloccante per il Prologo |
| Evidenza canonica | 🔴 293 nodi senza evidence | **`nodesWithoutEvidence: []` — 0 nodi senza evidenza** | ✅ risolto |
| Embeddings | 🟡 86 pending | **2743/2743 embeddati, 0 pending** (ultimo backfill 2026-07-03 20:08 UTC) | ✅ risolto |

Ulteriori indicatori dal `novel_bible_coverage_report`: `pendingCandidates: 0`, `untypedClaims: 0`, `duplicateCanonicalNodes: 0`, `genericRelatedToEdges: 0`, `sectionMappedOnly: []`, `claimMappedOnly: []`. L'unico finding residuo è `unmapped_bible_sections` con severità **warning** (non error).

### 1.1 Le 76 sezioni non mappate: perché non bloccano il Prologo (ma vanno chiuse prima della stesura AI)

Le sezioni non mappate appartengono quasi tutte alle **schede personaggi** (2.1 Protagonisti, 2.2 Personaggi principali, 2.3 Forze sovrannaturali, 2.4 Secondari): voce e linguaggio, evoluzione psicologica, valori non negoziabili, "Controlli Operativi per Scrittura AI", verifiche crociate.

- **Per la revisione del Prologo**: le sezioni che governano il Prologo — cornice narrativa 2.6.x (Il Nonno, Asia, Elea, regole di copertura del narratore) e cronologia 1.4.2 — risultano **già consolidate** nel grafo con nodi canonici ed evidenza. Le sezioni non mappate restano comunque interrogabili come nodi `bible_section` (embeddate e raggiungibili via `kg_recall`/`kg_semantic_search`), quindi il contesto non va perso.
- **Per la stesura AI dei capitoli** (Processo B): le sezioni mancanti includono proprio "Linguaggio e 'Voce'" (2.1.2.8), "Evoluzione della Personalità", "Controlli Operativi per Scrittura AI" dei personaggi principali. **Raccomandazione: completare il mapping di queste 76 sezioni prima di far generare all'IA capitoli in cui quei personaggi parlano**, perché il context packet canonico ne uscirebbe più povero. Non è un blocco tecnico, è un rischio di qualità.

### 1.2 Punti di attenzione tecnici verificati sul codice del server

1. **`get_server_status` risponde `ok:false`** ma solo perché lo storage NAS è volutamente disabilitato (`storage.disabled: true`). Neo4j è connesso. Impatta esclusivamente `kg_attach_asset` e `novel_attach_generated_image` (già disabilitati by design in questo progetto). **Non bloccante.**
2. **Il nodo `chapter` "Prologo" non esiste ancora nel grafo** (esistono i 40 capitoli numerati; il Prologo oggi è presente solo come `timeline_event` canonico della Bibbia). Non serve crearlo a mano: `novel_start_editing_session` con `role: "prologo"` lo crea automaticamente (upsert con label `Prologo`, `canonStatus: draft`).
3. **`novel_ingest_chapter_draft` NON accetta `role`** (solo `chapterNumber` numerato): per il Prologo la bozza esterna **non si ingesta come documento**; il testo va passato direttamente a `novel_split_chapter_blocks` dentro la sessione di editing. È il comportamento previsto (regola 9 e 15 di `instructions.md`: il lavoro editoriale vive nel file di sessione, nel grafo entra solo il testo finale).
4. **Aggiornamenti 2026-07-03 (sera)**: `novel_get_chapter_context_packet` ora accetta anche `role` ("prologo"/"epilogo"); i blocchi editoriali sono AMPI per default (2500 parole, max 20000, capitolo intero ammesso come blocco unico) — il focus lo garantisce il canone del grafo; il fix permessi dello state dir (`/app/.state`) elimina l'EACCES su `novel_start_editing_session`.
5. **`novel_audit_chapter` richiede `chapterNumber`**: per il Prologo non è invocabile; la verifica finale passa da `novel_chapter_validation_packet` + `novel_chapter_postwrite_status` (che accettano `role`).
6. **Vincolo di riscrittura**: `novel_save_rewrite_block` rifiuta riscritture fuori dal range **85%–140%** della lunghezza del blocco originale.
7. Il testo del Prologo è già nel repository: `documentazione/prologo-cioccolata-calda-revisione-v2.md` (~3.100 parole di testo). È il "file esterno non agganciato al modello" da usare come input del Processo A.

---

## 2. PROCESSO A — Revisione completa del Prologo (partendo dal testo esistente)

Sequenza tool sottostante: `novel_start_editing_session(role)` → contesto → `novel_split_chapter_blocks` → findings → decisioni → riscritture 85-140% → assemblaggio → seam review → (eventuale `novel_scan_revision_impact`) → `novel_save_final_chapter(role)` → estrazione/validazione/commit candidati → post-write.

Esegui i prompt **nell'ordine**, uno per turno, nella sessione con il server MCP `Romanzo_Gabriele` collegato.

### Prompt A0 — Pre-flight check

```
Esegui il pre-flight check per la revisione del Prologo: chiama get_server_status,
kg_embedding_status e novel_bible_coverage_report. Confermami che: Neo4j è connesso,
gli embeddings sono completi (0 pending), pendingCandidates=0 e che gli unici finding
sono warning su sezioni non mappate. Se emerge un finding di severità error, fermati
e riportamelo senza procedere.
```

### Prompt A1 — Apertura sessione e raccolta contesto canonico

```
Apri la sessione editoriale del Prologo con novel_start_editing_session
(role: "prologo", title: "La Promessa della Cioccolata Calda") e riportami il sessionId.
Poi raccogli il contesto canonico completo per la revisione:
- novel_get_chapter_context_packet con task "revisione Prologo cornice narrativa
  27/12/2080" e characters ["Il Nonno", "Asia", "Elea"]
- novel_recall_context / kg_recall su "cornice narrativa Prologo cioccolata calda
  piuma angelica cometa" e su "regola di copertura del narratore interludi Trevor"
Sintetizzami i vincoli canonici vigenti sul Prologo: cronologia (27/12/2080), oggetti
simbolici (piuma, cioccolata calda, cometa), la narratorCoverageRule del Nonno (mai
rivelare che è la sua storia prima dell'Epilogo, attribuzione indiretta a Trevor),
atmosfera e voce. Non inventare nulla che non sia nel grafo.
```

### Prompt A2 — Caricamento testo e suddivisione in blocchi

```
Ti fornisco il testo del Prologo da revisionare (file
documentazione/prologo-cioccolata-calda-revisione-v2.md). Usa
novel_split_chapter_blocks sulla sessione <sessionId> con il testo completo,
maxWords 2500 e persist: true (se il testo sta in un blocco unico, tienilo intero:
il focus lo garantisce il canone del grafo, non la dimensione del blocco). Riportami l'elenco dei blocchi (numero, prime parole,
conteggio parole) e conferma che la somma ricostruisce l'intero testo.

<incolla qui il testo integrale del Prologo>
```

### Prompt A3 — Revisione di continuity (step 1)

```
Esegui lo step di CONTINUITY sul Prologo, blocco per blocco. Per ogni blocco confronta
il testo con il canone del grafo (usa kg_recall, kg_semantic_search e i vincoli
raccolti al Prompt A1) e verifica: date e cronologia della cornice (27/12/2080),
età e caratterizzazione di Asia (6 anni) ed Elea (9), coerenza degli oggetti simbolici
(piuma angelica, ciondolo, cioccolata calda, cometa), rispetto della
narratorCoverageRule (il Nonno non deve mai tradire la propria identità né conoscenza
diretta non giustificabile), assenza di anticipazioni/spoiler vietati dalla Bibbia.
Registra ogni problema con novel_save_editorial_findings sulla sessione <sessionId>
(categoria continuity, con blockNumber, severità, descrizione e proposta di fix).
Riportami la tabella dei finding.
```

### Prompt A4 — Revisione stilistica ed editoriale (step 2)

```
Esegui lo step di STILE sul Prologo, blocco per blocco, applicando le style_rule e i
motivi ricorrenti presenti nel grafo (recuperali con kg_search type "style_rule" e
type "motif"): voce del narratore anziano in prima persona, ritmo, ripetizioni,
dialoghi delle bambine credibili per età, gestione del mistero senza spiegoni.
Registra i finding con novel_save_editorial_findings (categorie style/voice/pacing),
senza riscrivere ancora nulla. Riportami l'elenco completo dei finding aperti
(continuity + stile) con il loro findingId.
```

### Prompt A5 — Decisioni dell'utente

```
Ecco le mie decisioni sui finding: <per ogni findingId: approved / rejected / deferred,
con eventuale nota>. Registrale con novel_save_user_decisions sulla sessione
<sessionId> e confermami il quadro: quanti finding approvati andranno applicati in
riscrittura, quanti rifiutati, quanti rinviati.
```

### Prompt A6 — Riscrittura blocco per blocco (step 3)

```
Riscrivi il blocco <N> del Prologo applicando SOLO i finding approvati che lo
riguardano. Vincoli: lunghezza tra 85% e 140% dell'originale (enforced dal tool),
nessun fatto nuovo fuori canone, voce e tono invariati. Salva con
novel_save_rewrite_block (sessionId <sessionId>, blockNumber <N>, originalText,
revisedText, appliedFindingIds, approved: false) e mostrami il diff sintetico
originale→revisione con la percentuale di lunghezza. Attendi la mia approvazione
prima di passare al blocco successivo.
```

(Ripetere per ogni blocco; dopo l'approvazione di ciascuno, richiedere il salvataggio con `approved: true`.)

### Prompt A7 — Assemblaggio e revisione delle saldature (step 4)

```
Assembla la revisione completa con novel_assemble_chapter_revision (sessionId
<sessionId>, expectedBlocks <numero blocchi>). Se mancano blocchi, fermati ed
elencameli. Poi rileggi il testo unificato e fai la seam review: transizioni tra
blocchi, ripetizioni introdotte dalle riscritture, coerenza interna di tono e ritmo.
Salva l'esito con novel_save_seam_review (summary, findings, approved solo dopo il
mio ok) e presentami il testo finale completo per lettura.
```

### Prompt A8 — Scan di impatto (solo se la revisione ha cambiato fatti canonici)

```
La revisione modifica questi fatti già canonici: <elenco: nodo/etichetta → vecchio
contenuto → nuovo contenuto>. Esegui novel_scan_revision_impact (role: "prologo",
changedFacts) e riportami i nodi impattati, i conflitti di polarità e gli shift
semantici. NON propagare nessuna modifica a cascata: presentami solo il report e
le azioni proposte, decido io quali applicare.
```

### Prompt A9 — Canonizzazione del testo finale

```
Canonizza il Prologo: chiama novel_save_final_chapter con sessionId <sessionId>,
role "prologo", title "La Promessa della Cioccolata Calda", status "approved" e il
testo finale assemblato e approvato. Confermami che il nodo chapter "Prologo" è
stato aggiornato in place (canonStatus canonical, finalHash valorizzato) e che il
file di sessione è stato eliminato.
```

### Prompt A10 — Estrazione, validazione e commit dei fatti del Prologo

```
Estrai i fatti narrativi dal testo finale del Prologo con
novel_extract_chapter_candidates (role: "prologo", content: <testo finale>).
Poi valida i candidati con novel_chapter_validation_packet e mostrami: candidati
estratti, errori di validazione, discrepanze verso il canone esistente (lessicali e
semantiche) con la loro severità. Proponimi la lista finale da committare
distinguendo: nuovi nodi, nuovi archi, candidati da scartare perché duplicati di
canone esistente. Attendi il mio ok, poi esegui novel_commit_chapter_candidates
solo sui candidati approvati.
```

### Prompt A11 — Post-write e chiusura

```
Chiudi il ciclo: esegui novel_chapter_postwrite_status (role: "prologo", nodeIds:
<id committati>), kg_backfill_embeddings (missingOnly: true), kg_audit_global e
novel_bible_coverage_report. Riportami: che tutti i nodi committati esistono, sono
canonici e collegati; che non ci sono nuovi nodi senza embedding; che l'audit non
segnala regressioni. Riepilogami cosa è entrato nel canone con questo ciclo.
```

### Prompt A12 (opzionale) — Visual brief

```
Prepara il visual brief della scena chiave del Prologo con novel_create_visual_brief
sulla sessione ancora aperta (da eseguire PRIMA di A9, perché la canonizzazione
elimina il file di sessione): sceneSummary, characters, promptIt e promptEn coerenti
con l'illustrazione esistente documentazione/illustrazioni-capitoli-2026-07-02/
prologo-la-promessa-della-cioccolata-calda.png. Nota: l'attach dell'immagine da
filesystem è disabilitato in questo progetto; il brief resta nel file di sessione.
```

> ⚠️ Nota d'ordine: se vuoi il visual brief, eseguilo prima di A9 (la canonizzazione cancella la sessione).

---

## 3. PROCESSO B — Stesura + revisione completa (l'IA genera il testo dai principi della Bibbia)

Differenze rispetto al Processo A: non esiste testo di partenza (l'unica fonte è il canone della Bibbia nel grafo), non esiste scan di impatto (nessuna versione precedente), e la prima bozza viene generata dall'IA sotto vincolo stretto di canone. Dal momento in cui esiste la bozza, il flusso converge sugli stessi step del Processo A.

Esempio parametrizzato su un capitolo numerato `<N>` (per Prologo/Epilogo sostituire `chapterNumber: <N>` con `role: "prologo"`/`"epilogo"` in tutti i tool che lo prevedono).

### Prompt B0 — Pre-flight check (identico ad A0, più verifica copertura personaggi)

```
Esegui il pre-flight check per la stesura del Capitolo <N>: get_server_status,
kg_embedding_status, novel_bible_coverage_report. In più: identifica dal grafo i
personaggi che compaiono nel Capitolo <N> e verifica se le loro sezioni Bibbia
di voce/psicologia ("Linguaggio e 'Voce'", "Evoluzione", "Controlli Operativi per
Scrittura AI") risultano tra le sezioni non mappate del coverage report. Se sì,
segnalamelo: decido io se completare prima il mapping o procedere comunque.
```

### Prompt B1 — Raccolta del dossier di scrittura

```
Prepara il dossier completo per scrivere il Capitolo <N> usando SOLO il grafo:
- novel_get_chapter_context_packet (task: "stesura Capitolo <N>", chapterNumber: <N>)
- kg_get_node del nodo chapter "Capitolo <N>" e kg_neighbors (depth 2) per eventi,
  thread e vincoli collegati
- novel_recall_context sui personaggi coinvolti: stato emotivo, knowledge_state
  (chi sa cosa in questo punto della storia), relationship_dynamic, voce
- kg_search su style_rule, motif e narrative_constraint applicabili
- cronologia: data del capitolo, eventi immediatamente precedenti e successivi
  (archi precedes)
Restituiscimi il dossier strutturato: scena/e attese dalla Bibbia, personaggi con
stato e voce al momento della scena, vincoli non negoziabili, cosa NON può ancora
essere rivelato al lettore, aggancio con il capitolo precedente e successivo.
Dichiara esplicitamente ogni punto in cui la Bibbia è silente: lì NON dovrai
inventare canone, ma segnalarmi la scelta narrativa come proposta.
```

### Prompt B2 — Apertura sessione e generazione della prima bozza

```
Apri la sessione con novel_start_editing_session (chapterNumber: <N>, title:
"<titolo dal grafo>") e scrivi la PRIMA BOZZA completa del Capitolo <N> rispettando
rigorosamente il dossier del Prompt B1: nessun elemento fuori Bibbia, stato e voce
dei personaggi al momento della scena, vincoli di rivelazione, stile e motivi del
romanzo, lunghezza target <X> parole (adeguata agli altri capitoli). Le micro-scelte
non coperte dalla Bibbia (dettagli sensoriali, battute minori) sono ammesse solo se
canonicamente neutre: elencale a fine bozza in una sezione "Proposte non canoniche"
così le valido. Presentami la bozza integrale.
```

### Prompt B3 — Ingestion della bozza come materiale di lavoro (solo capitoli numerati)

```
Ho letto la bozza e voglio procedere <eventuali richieste di modifica preliminari>.
Registrala come materiale di lavoro con novel_ingest_chapter_draft
(chapterNumber: <N>, title, content, status: "draft") e poi suddividila nella
sessione con novel_split_chapter_blocks (persist: true, maxWords 2500 — blocco
unico se il testo ci sta).
Riportami blocchi e conteggi. Ricorda: la bozza NON è canone.
```

(Per Prologo/Epilogo: saltare l'ingest e usare solo `novel_split_chapter_blocks`, come nel Processo A.)

### Prompt B4 — Auto-revisione di continuity della bozza generata

```
Ora fai il revisore del tuo stesso testo, con massima severità. Esegui lo step di
CONTINUITY blocco per blocco confrontando la bozza con il grafo (kg_recall,
kg_semantic_search) e con novel_audit_chapter (chapterNumber: <N>, content: <bozza>).
Cerca in particolare gli errori tipici della generazione: fatti inventati non
presenti in Bibbia, personaggi che sanno cose che a questo punto non sanno
(knowledge_state), anacronismi di cronologia, violazioni di narrative_constraint,
anticipazioni vietate. Registra tutto con novel_save_editorial_findings e riportami
la tabella dei finding.
```

### Prompt B5 → B12 — Convergenza sul flusso di revisione

Da qui il processo è identico al Processo A: usare i Prompt **A4** (stile), **A5** (decisioni), **A6** (riscritture 85–140%), **A7** (assemblaggio + seam review), **A12 opzionale** (visual brief, prima della canonizzazione), **A9** (canonizzazione con `chapterNumber: <N>`), **A10** (estrazione/validazione/commit candidati), **A11** (post-write), sostituendo `role: "prologo"` con `chapterNumber: <N>`. **Non eseguire A8** (`novel_scan_revision_impact`): non esiste una versione precedente del capitolo, quindi nessun impatto da scandire.

---

## 4. Cosa fare PRIMA di partire (checklist finale)

1. ✅ Niente da fare su embeddings ed evidenze: già a posto (verificato 2026-07-03).
2. 🟡 **Consigliato, non bloccante per il Prologo**: chiudere il mapping delle 76 sezioni Bibbia residue (schede personaggi 2.1–2.4). Prompt suggerito, ripetibile a lotti:
   ```
   Dal novel_bible_coverage_report prendi le prime 10 sezioni non mappate. Per
   ciascuna: novel_get_bible_mapping_packet, poi novel_extract_bible_candidates
   (granularity "both") e presentami i candidati con la validazione
   (novel_bible_validation_packet). Dopo il mio ok, novel_commit_bible_candidates
   e chiudi con novel_bible_postwrite_status + kg_backfill_embeddings
   (missingOnly: true). Ripeti il coverage report e dimmi quante sezioni restano.
   ```
3. ✅ Per il Prologo si parte direttamente dal **Prompt A0**: il nodo chapter viene creato dalla sessione, il testo v2 è in `documentazione/prologo-cioccolata-calda-revisione-v2.md`.
