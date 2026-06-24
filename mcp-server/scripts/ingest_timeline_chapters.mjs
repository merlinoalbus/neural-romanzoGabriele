import neo4j from 'neo4j-driver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.deploy.dev');

// Load environment variables
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...parts] = trimmed.split('=');
      const val = parts.join('=').trim().replace(/^['"]|['"]$/g, '');
      process.env[key.trim()] = val;
    }
  }
}

const pid = process.env.PROJECT_ID || 'romanzo-gabriele';
const neo4jUri = 'bolt://localhost:7687';
const neo4jUser = process.env.NEO4J_USER || 'neo4j';
const neo4jPassword = process.env.NEO4J_PASSWORD;

async function main() {
  console.log('=== STARTING TIMELINE INGESTION FOR CHAPTERS 2, 3, AND 4 ===');
  
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();

  const provenanceStr = JSON.stringify({ source: 'ingest_timeline_chapters_script', pid });
  const ts = new Date().toISOString();

  try {
    // 1. Ingest Bible Claims / Rules
    console.log('Ingesting school start and sculpture claims...');
    const claims = [
      {
        id: 'claim-inizio-scuola-1-settembre',
        type: 'bible_claim',
        label: 'Inizio dell\'anno scolastico il 1 Settembre',
        content: 'L\'anno scolastico inizia ufficialmente il 1 Settembre. Questo garantisce a Gabriele un arco temporale di circa 25 giorni (fino alla scadenza del 26 Settembre) per lavorare al concorso "Metamorfosi Creativa".',
        metadata: JSON.stringify({ category: 'chronology', schoolStart: '09-01' })
      },
      {
        id: 'claim-scultura-risveglio-inconsapevole',
        type: 'bible_claim',
        label: 'La scultura dei cigni è un\'infusione angelica inconscia',
        content: 'La scultura dei due cigni è creata da Gabriele spinto da un misto di abilità umana (imparata osservando il nonno) e grazia angelica latente. Le persone avvertono un\'aura "viva" ed emotivamente travolgente, ma l\'opera rimane indubbiamente fatta di legno. Questo precede la prima piuma fisica (manifestazione tangibile) della notte del 29 Settembre.',
        metadata: JSON.stringify({ category: 'lore', object: 'scultura_cigni' })
      }
    ];

    for (const c of claims) {
      await session.run(`
        MERGE (n:Entity {id: $id})
        ON CREATE SET
          n.type = $type,
          n.label = $label,
          n.content = $content,
          n.projectId = $pid,
          n.createdAt = $ts,
          n.updatedAt = $ts,
          n.metadata = $metadata,
          n.provenance = $provenanceStr
        ON MATCH SET
          n.label = $label,
          n.content = $content,
          n.updatedAt = $ts,
          n.metadata = $metadata
      `, { id: c.id, type: c.type, label: c.label, content: c.content, pid, ts, metadata: c.metadata, provenanceStr });
    }

    // 2. Create/Update Chapters (Matching on unique type, label, projectId)
    console.log('Creating/updating chapter nodes...');
    const chapters = [
      { id: 'chapter-002', label: 'Capitolo 2', content: 'La legge del corridoio' },
      { id: 'chapter-003', label: 'Capitolo 3', content: 'Un concorso per sognare' },
      { id: 'chapter-004', label: 'Capitolo 4', content: 'La nascita dei cigni' }
    ];

    for (const ch of chapters) {
      await session.run(`
        MERGE (n:Entity {type: 'chapter', label: $label, projectId: $pid})
        ON CREATE SET
          n.id = $id,
          n.content = $content,
          n.createdAt = $ts,
          n.updatedAt = $ts,
          n.metadata = '{}',
          n.provenance = $provenanceStr
        ON MATCH SET
          n.content = $content,
          n.updatedAt = $ts
      `, { id: ch.id, label: ch.label, content: ch.content, pid, ts, provenanceStr });
    }

    // 3. Define and Ingest Timeline Events
    console.log('Ingesting timeline events...');
    const events = [
      // Chapter 2 Events
      { id: 'ev-c2-1', chLabel: 'Capitolo 2', label: 'ev-c2-1: Risveglio e ansia', content: 'Mattina: Risveglio difficile, ansia per la scuola. Colazione silenziosa.', chars: ['Gabriele Rinaldi (Gabriel)'] },
      { id: 'ev-c2-2', chLabel: 'Capitolo 2', label: 'ev-c2-2: Incontro con Trevor', content: 'Incontro con Trevor: Trevor lo aspetta all\'angolo. Parla del suo blog "SpeedyGonzy" e dell\'ultimo articolo sulla "gestione creativa" dei fondi del comitato studentesco, criticando la radio scolastica "Leonardo On Air" di Lisa.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)', 'Lisa Martini'] },
      { id: 'ev-c2-3', chLabel: 'Capitolo 2', label: 'ev-c2-3: Arrivo a scuola', content: 'Arrivo a Scuola: Caos nell\'atrio. Gabriele vede Lisa, prova ammirazione e disperazione.', chars: ['Gabriele Rinaldi (Gabriel)', 'Lisa Martini'] },
      { id: 'ev-c2-4', chLabel: 'Capitolo 2', label: 'ev-c2-4: Scontro con Cristiano', content: 'Scontro con Cristiano: Cristiano, con Marco e Stefano, blocca Gabriele e Trevor nel corridoio. Li insulta, deridendo l\'aspetto di Gabriele e la sua cotta per Lisa.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)', 'Cristiano', 'Marco Barbieri', 'Stefano Ferrari', 'Lisa Martini'] },
      { id: 'ev-c2-5', chLabel: 'Capitolo 2', label: 'ev-c2-5: Intervento di Trevor', content: 'Intervento di Trevor: Trevor risponde a tono a Cristiano, difendendo Gabriele.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)', 'Cristiano'] },
      { id: 'ev-c2-6', chLabel: 'Capitolo 2', label: 'ev-c2-6: Difesa silenziosa di Gabriele', content: 'Reazione di Gabriele: Spinto dalla rabbia e dalla lealtà, Gabriele interviene per difendere Trevor, parlando con voce tremante ma ferma, mettendosi fisicamente in mezzo per proteggerlo.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)', 'Cristiano'] },
      { id: 'ev-c2-7', chLabel: 'Capitolo 2', label: 'ev-c2-7: Aggressione fisica', content: 'Aggressione: Cristiano spinge Gabriele contro gli armadietti ed è sul punto di colpirlo.', chars: ['Gabriele Rinaldi (Gabriel)', 'Cristiano'] },
      { id: 'ev-c2-8', chLabel: 'Capitolo 2', label: 'ev-c2-8: Salvataggio campanella', content: 'Salvataggio dalla Campanella: La campanella suona, interrompendo l\'aggressione. Cristiano si allontana minaccioso.', chars: ['Cristiano'] },
      { id: 'ev-c2-9', chLabel: 'Capitolo 2', label: 'ev-c2-9: Umiliazione di Gabriele', content: 'Conseguenze: Gabriele è scosso, umiliato, la speranza di un nuovo inizio distrutta.', chars: ['Gabriele Rinaldi (Gabriel)'] },

      // Chapter 3 Events
      { id: 'ev-c3-1', chLabel: 'Capitolo 3', label: 'ev-c3-1: Limbo mattutino', content: 'Limbo Mattutino: Gabriele passa le prime ore di lezione come un automa, svuotato.', chars: ['Gabriele Rinaldi (Gabriel)'] },
      { id: 'ev-c3-2', chLabel: 'Capitolo 3', label: 'ev-c3-2: Pranzo con Trevor', content: 'Pausa Pranzo: In mensa con Trevor, silenzio teso.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)'] },
      { id: 'ev-c3-3', chLabel: 'Capitolo 3', label: 'ev-c3-3: Annuncio radio di Lisa', content: 'Annuncio Radio: La voce di Lisa (Leonardo On Air) annuncia il concorso artistico "Metamorfosi Creativa" per raccogliere fondi per il Ballo di Carnevale. Tema libero.', chars: ['Lisa Martini'] },
      { id: 'ev-c3-4', chLabel: 'Capitolo 3', label: 'ev-c3-4: Dettagli del concorso', content: "Dettagli del Concorso: Consegna opere entro il 26 Settembre. Premiazione il 29 Settembre (compleanno di Gabriele). Giuria composta da insegnanti d'arte (Prof. Moretti, Sig.ra Conti) e dall'artista locale Marco Bellini.", chars: ['Gabriele Rinaldi (Gabriel)', 'Prof. Moretti', 'Sig.ra Conti', 'Marco Bellini'] },
      { id: 'ev-c3-5', chLabel: 'Capitolo 3', label: 'ev-c3-5: Il premio e Lisa', content: 'Il Premio: Esposizione dell\'opera vincitrice e una "giornata premio" da trascorrere con un ragazzo della squadra di basket o una ragazza del gruppo di supporto/comitato organizzativo del ballo (di cui Lisa fa parte). Tutte le opere saranno messe all\'asta.', chars: ['Lisa Martini'] },
      { id: 'ev-c3-6', chLabel: 'Capitolo 3', label: 'ev-c3-6: Reazione di Gabriele', content: 'Reazione di Gabriele: Profondamente colpito dalla coincidenza delle date e dalla possibilità di scegliere Lisa. Prova un misto di eccitazione e terrore.', chars: ['Gabriele Rinaldi (Gabriel)', 'Lisa Martini'] },
      { id: 'ev-c3-7', chLabel: 'Capitolo 3', label: 'ev-c3-7: Incoraggiamento di Trevor', content: 'Incoraggiamento di Trevor: Trevor lo spinge con entusiasmo a partecipare, sicuro della sua vittoria e della possibilità di "sconvolgere il sistema".', chars: ['Trevor Rossi (SpeedyGonzy)'] },
      { id: 'ev-c3-8', chLabel: 'Capitolo 3', label: 'ev-c3-8: Decisione della scultura', content: 'Decisione: Gabriele decide di partecipare, thinking di creare una scultura in legno (un ceppo di tiglio regalatogli dal nonno).', chars: ['Gabriele Rinaldi (Gabriel)'] },

      // Chapter 4 Events
      { id: 'ev-c4-1', chLabel: 'Capitolo 4', label: 'ev-c4-1: Lavoro nel garage', content: 'Pomeriggio: Gabriele si dedica con fervore alla scultura nel garage.', chars: ['Gabriele Rinaldi (Gabriel)'] },
      { id: 'ev-c4-2', chLabel: 'Capitolo 4', label: 'ev-c4-2: Intaglio del tiglio', content: 'Descrizione del Lavoro: Trova il ceppo di tiglio del nonno. Prepara gli attrezzi. Inizia a scolpire con sorprendente sicurezza, l\'immagine dei due cigni che emerge spontaneamente.', chars: ['Gabriele Rinaldi (Gabriel)'] },
      { id: 'ev-c4-3', chLabel: 'Capitolo 4', label: 'ev-c4-3: Visita di Trevor', content: 'Visita di Trevor: Trevor lo trova immerso nel lavoro, coperto di polvere di legno. Lo prende in giro bonariamente ma lo supporta, portandogli da bere e facendogli compagnia.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)'] },
      { id: 'ev-c4-4', chLabel: 'Capitolo 4', label: 'ev-c4-4: L\'errore e disperazione', content: 'Inconveniente Tecnico: Gabriele commette un errore, scheggiando un\'ala della scultura. È disperato, pronto a mollare.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)'] },
      { id: 'ev-c4-5', chLabel: 'Capitolo 4', label: 'ev-c4-5: Rito della pizza', content: 'Supporto di Trevor: Trevor lo rincuora, lo aiuta a sdrammatizzare e a trovare una soluzione (la pizza diventa un rito).', chars: ['Trevor Rossi (SpeedyGonzy)'] },
      { id: 'ev-c4-6', chLabel: 'Capitolo 4', label: 'ev-c4-6: La commozione della madre', content: 'Fine Lavoro e Apprezzamento: La scultura è quasi finita. Trevor è sinceramente ammirato dalla bellezza dell\'opera. Anche la madre di Gabriele, vedendola, rimane profondamente commossa e nota qualcosa di "strano" e vivo nei cigni. Gabriele sente orgoglio e una sottile inquietudine.', chars: ['Gabriele Rinaldi (Gabriel)', 'Trevor Rossi (SpeedyGonzy)', 'Madre di Gabriele'] }
    ];

    for (const ev of events) {
      await session.run(`
        MERGE (n:Entity {id: $id})
        ON CREATE SET
          n.type = 'timeline_event',
          n.label = $label,
          n.content = $content,
          n.projectId = $pid,
          n.createdAt = $ts,
          n.updatedAt = $ts,
          n.metadata = '{}',
          n.provenance = $provenanceStr
        ON MATCH SET
          n.label = $label,
          n.content = $content,
          n.updatedAt = $ts
        WITH n
        MATCH (c:Entity {label: $chLabel, type: 'chapter', projectId: $pid})
        MERGE (n)-[r:REL {kind: 'part_of'}]->(c)
        ON CREATE SET r.id = $relId, r.createdAt = $ts, r.provenance = $provenanceStr
      `, {
        id: ev.id,
        label: ev.label,
        content: ev.content,
        pid,
        ts,
        provenanceStr,
        chLabel: ev.chLabel,
        relId: `rel-ev-ch-${crypto.randomUUID().slice(0, 8)}`
      });

      // Link event to character nodes
      for (const charLabel of ev.chars) {
        await session.run(`
          MATCH (e:Entity {id: $evId, projectId: $pid})
          MATCH (c:Entity {type: 'character', label: $charLabel, projectId: $pid})
          MERGE (e)-[r:REL {kind: 'mentions'}]->(c)
          ON CREATE SET r.id = $relId, r.createdAt = $ts, r.provenance = $provenanceStr
        `, {
          evId: ev.id,
          charLabel,
          pid,
          ts,
          provenanceStr,
          relId: `rel-ev-char-${crypto.randomUUID().slice(0, 8)}`
        });
      }
    }

    console.log('Timeline events and chapters ingested successfully!');
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
