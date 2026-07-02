# Suggerimenti di craft narrativo — Bibbia "Gabriele"

Queste NON sono incongruenze fattuali (già corrette nel modello) ma criticità di **distribuzione/ritmo** emerse dall'audit. Sono scelte autoriali: non toccano il grafo, sono raccomandazioni per la stesura/revisione. Riferimento: `dev-data/reports/2026-07-02T14-30-00Z-bibbia-incongruenze-audit.json`.

## [ALTA] Front-loading (DIST-01)
**Problema**: le Parti 1–2 (metà romanzo) coprono ~5 settimane con dettaglio giorno-per-giorno; la Parte 4 comprime ~4 mesi + l'intera risoluzione cosmica. La svolta di genere (rivelazione angelica) arriva al Cap. 30 (nuova num., ~72%).
**Suggerimenti**:
- Anticipare "semi" soprannaturali più marcati nelle Parti 1–2 (già ci sono piume/sogni: renderli più inquietanti e frequenti) per ridurre la sensazione di lunga rampa realistica.
- Espandere la Parte 4: dare respiro scenico agli eventi celesti (vedi DIST-04) invece di comprimerli, portando il baricentro del climax un po' prima.
- In alternativa (scelta di design legittima): mantenere il contrasto lento→cosmico come voluto, ma segnalarlo con un interludio-cerniera che prepari il salto di registro.

## [ALTA] Antagonista Cristiano → Michael (DIST-02)  — RISOLTO nel modello
**Decisione utente**: NON è arco abbandonato ma **successione di antagonista** (umano→celeste), parallela all'escalation di potere del protagonista. Registrato nel grafo come edge `supersedes` Michael→Cristiano.
**Suggerimenti di stesura**: dare a Cristiano una breve scena di chiusura/eco nella Parte 4 (anche solo il suo destino post-oblio visto di sfuggita) così il "passaggio di testimone" all'antagonista superiore è percepito, non solo implicito.

## [MEDIA] Cap. 30 sovraccarico (DIST-03)
~10 beat maggiori in un capitolo (scontro Cristiano, esplosione poteri, Raphael, rivelazione natura, backstory Caduta, ultimatum, oblio testimoni, riconciliazione Trevor…).
**Suggerimento**: spezzare in due (rivelazione/ultimatum ‖ conseguenze umane), o spostare la riconciliazione con Trevor al capitolo successivo, alleggerendo il fulcro della rivelazione.

## [MEDIA] Cap. 39 risoluzione off-page (DIST-04)
La svolta di Michael (da distruttore a fratello che approva) e la grazia divina sono **raccontate** da Gabriele, non drammatizzate.
**Suggerimento**: mostrare almeno un frammento scenico dell'intercessione celeste (flashback o visione) per dare peso emotivo al pay-off invece del solo resoconto.

## [MEDIA] Salto vuoto Cap. 24→25 (DIST-05)
Un mese (05/11–03/12) senza capitoli, ma il testo del Cap. 25 presenta gli eventi come immediatamente successivi ("nei giorni seguenti").
**Suggerimento**: o inserire un breve capitolo/interludio-ponte a novembre, o rendere esplicito il salto temporale nell'incipit del Cap. 25 per evitare la falsa continuità.

## [MEDIA] Laura Mancini: dossier ampio, zero scene (DIST-06)
Migliore amica di Lisa con dossier esteso, ma compare solo come nome nell'articolo (Cap. 24). Il tradimento dell'amicizia non ha scena di risoluzione.
**Suggerimento**: dedicare una scena on-page al confronto/frattura Lisa-Laura per monetizzare il set-up e dare peso alla ferita.

## [BASSA] Archi/oggetti senza pay-off
- **Diario di Gabriele** (DIST-09): dispositivo ricorrente fino al Cap. 30, poi sparisce; la sua sorte sotto l'oblio non è mai affrontata. → chiudere il cerchio (una entry finale, o il suo ritrovamento/scomparsa nell'Epilogo).
- **Scultura "Incontro di Cigni"** (DIST-10): simbolo centrale Gabriele-Lisa, esce di scena dopo l'asta senza chiusura simbolica (a differenza di piume/ciondolo che tornano nell'Epilogo). → farla riapparire nel finale.
- **Federica / Stefano** (DIST-08): dossier ampi ma ruoli mono-scena. → o ridurre i dossier, o dare loro un breve follow-up.

---
*Le date/refusi fattuali (Cap.12, scandalo, osservatorio, zoo, riferimento 2.4.11) e le riconciliazioni di worldbuilding (distorsione temporale, oblio, gerarchia Michael/Gabriel, coverage Nonno, piuma Trevor) sono già APPLICATE nel modello consolidato.*
