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
    console.log('=== CHECKING BIBLE SECTIONS FOR CHAPTERS 2, 3, 4 OUTLINES ===');
    const sections = ['5.1.3', '5.1.4', '5.1.5', '5.1.2'];
    for (const sec of sections) {
      const res = await session.run(`
        MATCH (n:Entity {type: 'bible_section', projectId: $pid})
        WHERE n.label CONTAINS $sec OR n.id CONTAINS $sec
        RETURN n.id as id, n.label as label, n.content as content
      `, { sec, pid });
      console.log(`\nQuery for "${sec}": found ${res.records.length} nodes:`);
      for (const r of res.records) {
        console.log(`  ID: ${r.get('id')} | Label: ${r.get('label')}`);
        console.log(`  Content: ${r.get('content').substring(0, 150)}...`);
      }
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
