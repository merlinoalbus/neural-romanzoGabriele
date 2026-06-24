import neo4j from 'neo4j-driver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

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
  console.log('=== STARTING GRAPH OPTIMIZATION (PHASE 5) ===');
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();
  const ts = new Date().toISOString();
  const provenanceStr = JSON.stringify({ source: 'optimize_graph_narrative_script', pid });

  try {
    // 1. Mark duplicates with duplicateOf in metadata
    console.log('1. Marking duplicate nodes in metadata...');
    const duplicateMappings = [
      // Secrets
      { id: '9546f591-c248-4f98-a58a-bdfd1e76954e', target: '858bbe20-b084-4195-9010-fe1bf7f278d5' },
      
      // Lisa - Cristiano dynamic
      { id: '882ff463-9e36-4a99-8298-02b0ec92d27a', target: 'ed614624-7a61-45c6-8301-fbf06222e67c' },
      { id: '351ab4fd-abb6-46a2-8f0f-80c35658bb3d', target: 'ed614624-7a61-45c6-8301-fbf06222e67c' },
      
      // Lisa - Elena Costa dynamic
      { id: '50a151ed-7703-48e8-b1a7-d5817a20e9e2', target: 'b158b364-a409-4d15-91b8-30de418aa2aa' },
      
      // Trevor - Cristiano dynamic
      { id: '5551b77c-4754-48e5-8b1e-a1095009e207', target: 'e5881893-9487-4387-9394-8b8fc711cd1f' },
      
      // Trevor - Lisa dynamic
      { id: '4001b9f1-4d4d-4b7c-8aea-d222f45aef1c', target: '277c0939-f52d-49e0-81c1-73c616e21a69' }
    ];

    for (const mapping of duplicateMappings) {
      const res = await session.run(`MATCH (n:Entity {id: $id, projectId: $pid}) RETURN n.metadata as metadata`, { id: mapping.id, pid });
      if (res.records.length > 0) {
        const metadata = JSON.parse(res.records[0].get('metadata') || '{}');
        metadata.duplicateOf = mapping.target;
        await session.run(`
          MATCH (n:Entity {id: $id, projectId: $pid})
          SET n.metadata = $metadata, n.updatedAt = $ts
        `, { id: mapping.id, pid, metadata: JSON.stringify(metadata), ts });
        console.log(`  * Marked duplicate node ${mapping.id} -> duplicateOf: ${mapping.target}`);
      } else {
        console.warn(`  * Node ${mapping.id} not found in DB!`);
      }
    }

    // 2. Trigger Active Inference Daemon to merge duplicates
    console.log('\n2. Running active inference daemon to perform mergers...');
    try {
      const output = execSync('node mcp-server/scripts/active_inference_daemon.mjs', { encoding: 'utf8' });
      console.log('Daemon output summary:');
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('Consolidation completed') || line.includes('Active inference daemon finished')) {
          console.log(`  ${line.trim()}`);
        }
      }
    } catch (daemonErr) {
      console.error('Active inference daemon execution failed:', daemonErr);
    }

    // 3. Create contextual links for Chapter 2, 3, 4 events
    console.log('\n3. Creating contextual linkages between timeline events, locations, themes and traits...');
    const links = [
      // Chapter 2 Locations
      { evId: 'ev-c2-1', destId: '115a0cb2-f05d-49ec-921f-de2c4b471119', kind: 'located_in' }, // Stanza di Gabriele
      { evId: 'ev-c2-2', destId: '14b412e2-1537-4d13-ac03-ce5b2b054295', kind: 'located_in' }, // Angolo/Muretto
      { evId: 'ev-c2-3', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' }, // Liceo
      { evId: 'ev-c2-4', destId: 'f5fd8996-128d-4a03-a208-f8365ea0346c', kind: 'located_in' }, // Corridoi della Scuola
      { evId: 'ev-c2-5', destId: 'f5fd8996-128d-4a03-a208-f8365ea0346c', kind: 'located_in' },
      { evId: 'ev-c2-6', destId: 'f5fd8996-128d-4a03-a208-f8365ea0346c', kind: 'located_in' },
      { evId: 'ev-c2-7', destId: 'f5fd8996-128d-4a03-a208-f8365ea0346c', kind: 'located_in' },
      { evId: 'ev-c2-8', destId: 'f5fd8996-128d-4a03-a208-f8365ea0346c', kind: 'located_in' },
      { evId: 'ev-c2-9', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' },

      // Chapter 2 Themes
      { evId: 'ev-c2-1', destId: 'b0176cf5-287d-4c58-b940-0deee1289664', kind: 'has_theme' }, // TRASFORMAZIONE E IDENTITÀ
      { evId: 'ev-c2-2', destId: 'c4667dc4-addc-4250-9bfe-48b137872952', kind: 'has_theme' }, // AMICIZIA E TRADIMENTO
      { evId: 'ev-c2-4', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' }, // BULLISMO
      { evId: 'ev-c2-5', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' },
      { evId: 'ev-c2-6', destId: '03d73c23-2eeb-4ce6-9acf-a29173ce12e5', kind: 'has_theme' }, // CORAGGIO E PAURA
      { evId: 'ev-c2-7', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' },
      { evId: 'ev-c2-9', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' },

      // Chapter 2 Traits
      { evId: 'ev-c2-6', destId: 'trait-timido-gabriele', kind: 'applies_to' },
      { evId: 'ev-c2-6', destId: '2d3903d6-2300-40be-8fac-a37544f4bd76', kind: 'applies_to' }, // Lealtà protettiva di Trevor

      // Chapter 3 Locations
      { evId: 'ev-c3-1', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' },
      { evId: 'ev-c3-2', destId: '47c2f746-15ad-457a-94f0-e2c3a0aba713', kind: 'located_in' }, // Mensa
      { evId: 'ev-c3-3', destId: '7fb68136-65ad-49d9-8c40-b943b635a568', kind: 'located_in' }, // Aula Radio
      { evId: 'ev-c3-4', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' },
      { evId: 'ev-c3-5', destId: 'bef06b18-5f3f-4234-b759-614fe09f0075', kind: 'located_in' },
      { evId: 'ev-c3-8', destId: '115a0cb2-f05d-49ec-921f-de2c4b471119', kind: 'located_in' }, // Stanza

      // Chapter 3 Themes
      { evId: 'ev-c3-2', destId: 'c4667dc4-addc-4250-9bfe-48b137872952', kind: 'has_theme' }, // AMICIZIA E TRADIMENTO
      { evId: 'ev-c3-3', destId: '07b6c18e-5328-4659-a254-190727c79833', kind: 'has_theme' }, // BULLISMO/SOCIALI
      { evId: 'ev-c3-8', destId: 'b0176cf5-287d-4c58-b940-0deee1289664', kind: 'has_theme' }, // TRASFORMAZIONE E IDENTITÀ

      // Chapter 4 Locations
      { evId: 'ev-c4-1', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' }, // Garage
      { evId: 'ev-c4-2', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' },
      { evId: 'ev-c4-3', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' },
      { evId: 'ev-c4-4', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' },
      { evId: 'ev-c4-5', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' },
      { evId: 'ev-c4-6', destId: 'a79e73a4-18d1-4dbf-9e6a-648be681e984', kind: 'located_in' },

      // Chapter 4 Themes
      { evId: 'ev-c4-1', destId: 'b0176cf5-287d-4c58-b940-0deee1289664', kind: 'has_theme' }, // TRASFORMAZIONE E IDENTITÀ
      { evId: 'ev-c4-2', destId: '1e5470ff-3ccc-42d9-b8cf-5d1b57fd17ec', kind: 'has_theme' }, // MISTERO E SOPRANNATURALE
      { evId: 'ev-c4-3', destId: 'c4667dc4-addc-4250-9bfe-48b137872952', kind: 'has_theme' }, // AMICIZIA E TRADIMENTO
      { evId: 'ev-c4-6', destId: '1e5470ff-3ccc-42d9-b8cf-5d1b57fd17ec', kind: 'has_theme' }  // MISTERO E SOPRANNATURALE
    ];

    for (const l of links) {
      const relId = `rel-ai-context-${crypto.randomUUID().slice(0, 8)}`;
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
    }
    console.log(`  * Successfully created ${links.length} contextual relationships.`);

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
