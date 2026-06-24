import neo4j from 'neo4j-driver';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();

  try {
    // 1. Locations
    console.log('=== LOCATIONS ===');
    const locRes = await session.run(`MATCH (n:Entity {type: 'location', projectId: $pid}) RETURN n.id as id, n.label as label`, { pid });
    for (const r of locRes.records) {
      console.log(`${r.get('id')} | ${r.get('label')}`);
    }

    // 2. Themes
    console.log('\n=== THEMES ===');
    const themeRes = await session.run(`MATCH (n:Entity {type: 'theme', projectId: $pid}) RETURN n.id as id, n.label as label`, { pid });
    for (const r of themeRes.records) {
      console.log(`${r.get('id')} | ${r.get('label')}`);
    }

    // 3. Traits
    console.log('\n=== TRAITS ===');
    const traitRes = await session.run(`MATCH (n:Entity {type: 'character_trait', projectId: $pid}) RETURN n.id as id, n.label as label`, { pid });
    for (const r of traitRes.records) {
      console.log(`${r.get('id')} | ${r.get('label')}`);
    }

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
