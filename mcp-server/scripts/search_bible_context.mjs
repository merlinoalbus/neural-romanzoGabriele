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
    console.log('=== Neo4j Research ===');
    
    // 1. Get characters and their traits
    console.log('\n--- Characters & Traits ---');
    const chars = await session.run(`
      MATCH (c:Entity {type: 'character', projectId: $pid})
      OPTIONAL MATCH (t:Entity {type: 'character_trait', projectId: $pid})-[:REL]-(c)
      RETURN c.label as label, collect(t.label) as traits
    `, { pid });
    for (const r of chars.records) {
      console.log(`- ${r.get('label')} | Traits: ${r.get('traits').join(', ')}`);
    }

    // 2. Get timeline events and dates
    console.log('\n--- Timeline Events ---');
    const timeline = await session.run(`
      MATCH (e:Entity {type: 'timeline_event', projectId: $pid})
      RETURN e.label as label, e.content as content
      LIMIT 40
    `, { pid });
    for (const r of timeline.records) {
      console.log(`- ${r.get('label')}: ${r.get('content')}`);
    }

    // 3. Get bible claims about the contest or dates
    console.log('\n--- Contest & Date claims ---');
    const claims = await session.run(`
      MATCH (n:Entity {projectId: $pid})
      WHERE n.type IN ['bible_claim', 'bible_section', 'world_rule', 'secret', 'character_belief', 'character_goal', 'character_wound']
      AND (
        n.content CONTAINS 'concorso' OR n.content CONTAINS 'Settembre' OR n.content CONTAINS '26' OR n.content CONTAINS '29' OR 
        n.content CONTAINS 'compleanno' OR n.content CONTAINS 'Leonardo' OR n.content CONTAINS 'tiglio' OR n.content CONTAINS 'Moretti' OR 
        n.content CONTAINS 'Conti' OR n.content CONTAINS 'Bellini' OR n.content CONTAINS 'scultura' OR n.content CONTAINS 'basket' OR
        n.label CONTAINS 'concorso' OR n.label CONTAINS 'Settembre' OR n.label CONTAINS 'compleanno' OR n.label CONTAINS 'Leonardo'
      )
      RETURN n.type as type, n.label as label, n.content as content
    `, { pid });
    for (const r of claims.records) {
      console.log(`- [${r.get('type')}] ${r.get('label')}: ${r.get('content').substring(0, 200)}...`);
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
