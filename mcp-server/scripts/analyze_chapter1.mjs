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
    console.log('=== ANALYZING CHAPTER 1 RELATIONSHIPS ===');
    
    // Find Chapter 1 node
    const chRes = await session.run(`
      MATCH (c:Entity {type: 'chapter', projectId: $pid})
      WHERE c.label CONTAINS '1'
      RETURN c.id as id, c.label as label, c.content as content
    `, { pid });
    
    if (chRes.records.length === 0) {
      console.error('Chapter 1 node not found!');
      return;
    }
    
    const ch = chRes.records[0];
    const chId = ch.get('id');
    console.log(`Chapter Node: "${ch.get('label')}" [${chId}]`);
    console.log(`Content: ${ch.get('content')}`);

    // Get all events connected to Chapter 1
    const eventsRes = await session.run(`
      MATCH (e:Entity {type: 'timeline_event', projectId: $pid})-[r:REL {kind: 'part_of'}]->(c:Entity {id: $chId})
      RETURN e.id as id, e.label as label, e.content as content
    `, { chId, pid });

    console.log(`\nTimeline Events connected to Chapter 1 (${eventsRes.records.length}):`);
    for (const r of eventsRes.records) {
      const evId = r.get('id');
      console.log(`\n* Event: "${r.get('label')}" [${evId}]`);
      console.log(`  Content: ${r.get('content')}`);
      
      // Get all outgoing/incoming connections for this event
      const connRes = await session.run(`
        MATCH (e:Entity {id: $evId, projectId: $pid})-[r:REL]-(other:Entity {projectId: $pid})
        WHERE other.id <> $chId
        RETURN r.kind as kind, other.id as otherId, other.type as otherType, other.label as otherLabel, startNode(r).id = $evId as isStart
      `, { evId, chId, pid });
      
      console.log(`  Connections (${connRes.records.length}):`);
      for (const cr of connRes.records) {
        const dir = cr.get('isStart') ? 'out' : 'in';
        console.log(`    - [${dir}] -[${cr.get('kind')}]-> (${cr.get('otherType')}:${cr.get('otherLabel')} [${cr.get('otherId')}])`);
      }
    }

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
