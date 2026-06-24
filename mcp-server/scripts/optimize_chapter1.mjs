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
  console.log('=== STARTING CHAPTER 1 RELATION OPTIMIZATION ===');
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();
  const ts = new Date().toISOString();
  const provenanceStr = JSON.stringify({ source: 'optimize_chapter1_script', pid });

  try {
    const links = [
      // 1. Dialogo con la madre prima del rientro a scuola
      { evId: '18e343bf-d964-4784-85a4-e2690b4aac83', destId: '115a0cb2-f05d-49ec-921f-de2c4b471119', kind: 'located_in' }, // Stanza di Gabriele
      { evId: '18e343bf-d964-4784-85a4-e2690b4aac83', destId: '2c67bda3-f0bd-4753-9069-ece3d233bb77', kind: 'mentions' }, // Madre di Gabriele
      { evId: '18e343bf-d964-4784-85a4-e2690b4aac83', destId: '65a0558e-5b36-44e2-b031-784da1e275ce', kind: 'has_theme' }, // LA RICERCA DI NORMALITÀ E APPARTENENZA

      // 2. Gabriele disegna Lisa e accartoccia il foglio
      { evId: '7fc0a6f9-013e-4e67-80f4-125343707d7e', destId: '115a0cb2-f05d-49ec-921f-de2c4b471119', kind: 'located_in' }, // Stanza di Gabriele
      { evId: '7fc0a6f9-013e-4e67-80f4-125343707d7e', destId: '2535b915-f630-4ebf-9329-3addec688c6a', kind: 'mentions' }, // Lisa Martini
      { evId: '7fc0a6f9-013e-4e67-80f4-125343707d7e', destId: 'df698b81-a4fc-4a4b-92e1-6f23ed5ebdbf', kind: 'mentions' }, // Gabriele
      { evId: '7fc0a6f9-013e-4e67-80f4-125343707d7e', destId: 'c553ea4a-92c0-49cc-9b2a-a510f808b6d3', kind: 'has_theme' }, // AMORE PROIBITO E SACRIFICIO

      // 3. Ricordo dello sgambetto di Cristiano alla vigilia della scuola
      { evId: '5a83170d-b2dc-4cb1-8ab2-154e27759f4d', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' }, // Liceo
      { evId: '5a83170d-b2dc-4cb1-8ab2-154e27759f4d', destId: '61e91878-2a3c-4763-9e7e-427ea36d3a1f', kind: 'mentions' }, // Cristiano
      { evId: '5a83170d-b2dc-4cb1-8ab2-154e27759f4d', destId: '2535b915-f630-4ebf-9329-3addec688c6a', kind: 'mentions' }, // Lisa Martini
      { evId: '5a83170d-b2dc-4cb1-8ab2-154e27759f4d', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' }, // BULLISMO

      // 4. Vigilia scolastica di Gabriele nella sua stanza
      { evId: '207b2ade-8add-4965-8b03-964dade01d8f', destId: 'df698b81-a4fc-4a4b-92e1-6f23ed5ebdbf', kind: 'mentions' }, // Gabriele
      { evId: '207b2ade-8add-4965-8b03-964dade01d8f', destId: 'trait-timido-gabriele', kind: 'applies_to' }, // timido
      { evId: '207b2ade-8add-4965-8b03-964dade01d8f', destId: 'b0176cf5-287d-4c58-b940-0deee1289664', kind: 'has_theme' }, // TRASFORMAZIONE E IDENTITÀ
      { evId: '207b2ade-8add-4965-8b03-964dade01d8f', destId: '65a0558e-5b36-44e2-b031-784da1e275ce', kind: 'has_theme' }  // LA RICERCA DI NORMALITÀ
    ];

    console.log('Creating contextual edges in Neo4j...');
    let count = 0;
    for (const l of links) {
      const relId = `rel-ch1-link-${crypto.randomUUID().slice(0, 8)}`;
      await session.run(`
        MATCH (from:Entity {id: $evId, projectId: $pid})
        MATCH (to:Entity {id: $destId, projectId: $pid})
        MERGE (from)-[r:REL {kind: $kind}]->(to)
        ON CREATE SET r.id = $relId, r.createdAt = $ts, r.provenance = $provenanceStr
      `, {
        evId: l.evId,
        destId: l.destId,
        kind: l.kind,
        pid,
        relId,
        ts,
        provenanceStr
      });
      console.log(`  * Created edge: ${l.evId} -[${l.kind}]-> ${l.destId}`);
      count++;
    }
    console.log(`Successfully completed Chapter 1 optimization. Created ${count} edges.`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
