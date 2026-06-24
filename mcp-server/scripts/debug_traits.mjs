import neo4j from 'neo4j-driver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();
  
  try {
    const res = await session.run(`
      MATCH (t:Entity {type: 'character_trait'})-[:applies_to|part_of|derived_from]-(c:Entity {type: 'character'}) 
      RETURN t.id as id, t.label as label, t.content as content, c.id as charId, c.label as charLabel
    `);
    
    console.log(`Matched Traits: ${res.records.length}`);
    for (const r of res.records) {
      console.log(`- Trait: '${r.get('label')}' linked to character '${r.get('charLabel')}' (Id: ${r.get('charId')})`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
