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
    console.log('=== Detailed Research on Sculpture, Contest and Chapters ===');
    
    // 1. Get sculpture details
    const sculptureRes = await session.run(`
      MATCH (n:Entity {projectId: $pid})
      WHERE n.label CONTAINS 'scultura' OR n.content CONTAINS 'scultura' OR n.label CONTAINS 'cigni' OR n.content CONTAINS 'cigni'
      RETURN n.type as type, n.label as label, n.content as content, n.metadata as metadata
    `, { pid });
    for (const r of sculptureRes.records) {
      console.log(`\n- [${r.get('type')}] ${r.get('label')}:\n  Content: ${r.get('content')}\n  Metadata: ${r.get('metadata')}`);
    }

    // 2. Get contest details
    console.log('\n--- Contest Details ---');
    const contestRes = await session.run(`
      MATCH (n:Entity {projectId: $pid})
      WHERE n.label CONTAINS 'concorso' OR n.content CONTAINS 'concorso' OR n.label CONTAINS 'Metamorfosi' OR n.content CONTAINS 'Metamorfosi'
      RETURN n.type as type, n.label as label, n.content as content
    `, { pid });
    for (const r of contestRes.records) {
      console.log(`- [${r.get('type')}] ${r.get('label')}: ${r.get('content')}`);
    }

    // 3. Get Chapter 2 & 3 existing nodes in the DB
    console.log('\n--- Chapter 2 & 3 Nodes in DB ---');
    const chRes = await session.run(`
      MATCH (c:Entity {projectId: $pid})
      WHERE c.type = 'chapter' AND (c.label CONTAINS '2' OR c.label CONTAINS '3')
      RETURN c.label as label, c.content as content, c.metadata as metadata
    `, { pid });
    for (const r of chRes.records) {
      console.log(`- ${r.get('label')}: ${r.get('content')} | Metadata: ${r.get('metadata')}`);
    }
    
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
