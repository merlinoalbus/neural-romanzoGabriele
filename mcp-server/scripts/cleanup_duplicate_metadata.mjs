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
  console.log('=== CLEANING UP DUPLICATEOF METADATA ===');
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();

  try {
    const res = await session.run(`
      MATCH (n:Entity {projectId: $pid})
      WHERE n.metadata CONTAINS 'duplicateOf'
      RETURN n.id as id, n.metadata as metadata
    `, { pid });

    let cleaned = 0;
    for (const r of res.records) {
      const id = r.get('id');
      const metadata = JSON.parse(r.get('metadata') || '{}');
      if (metadata.duplicateOf === id) {
        delete metadata.duplicateOf;
        await session.run(`
          MATCH (n:Entity {id: $id, projectId: $pid})
          SET n.metadata = $metadata
        `, { id, pid, metadata: JSON.stringify(metadata) });
        console.log(`  * Removed self-referential duplicateOf metadata from node "${id}"`);
        cleaned++;
      }
    }
    console.log(`Cleaned up ${cleaned} self-referential metadata entries.`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
