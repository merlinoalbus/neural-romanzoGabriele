import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env.deploy.dev');

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
  console.log('=== ADDING TRAIT TO GABRIELE RINALDI (GABRIEL) ===');
  
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();
  
  try {
    const charRes = await session.run(`
      MATCH (c:Entity {type: 'character', label: 'Gabriele Rinaldi (Gabriel)', projectId: $pid})
      RETURN c.id as id
    `, { pid });
    
    if (charRes.records.length === 0) {
      console.error('Gabriele Rinaldi (Gabriel) not found in database.');
      return;
    }
    
    const charId = charRes.records[0].get('id');
    console.log(`Found Gabriele (ID: ${charId})`);
    
    const traitId = 'trait-timido-gabriele';
    const traitLabel = 'timido';
    const traitContent = 'Gabriele è molto timido e introverso, tende a evitare gli scontri verbali e a non urlare in pubblico.';
    const provenanceStr = JSON.stringify({ source: 'manual_seed' });
    const metadataStr = '{}';

    await session.run(`
      MERGE (t:Entity {id: $traitId})
      ON CREATE SET
        t.type = 'character_trait',
        t.label = $traitLabel,
        t.content = $traitContent,
        t.projectId = $pid,
        t.createdAt = toString(datetime()),
        t.updatedAt = toString(datetime()),
        t.metadata = $metadataStr,
        t.provenance = $provenanceStr
      ON MATCH SET
        t.updatedAt = toString(datetime())
      WITH t
      MATCH (c:Entity {id: $charId})
      MERGE (t)-[:applies_to]->(c)
    `, { traitId, traitLabel, traitContent, pid, charId, provenanceStr, metadataStr });
    
    console.log('Successfully created and linked "timido" trait to Gabriele!');
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
