import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
const mcpUrl = 'http://127.0.0.1:13004/mcp';
const neo4jUri = 'bolt://localhost:7687';
const neo4jUser = process.env.NEO4J_USER || 'neo4j';
const neo4jPassword = process.env.NEO4J_PASSWORD;

async function main() {
  console.log('=== TEST: RE-INGEST DRAFT AND AUDIT ===');
  
  const client = new Client({ name: 'test-ingest-linter-re', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);

  try {
    const content = 'Gabriele Rinaldi (Gabriel) si alza in piedi di scatto e urla sfrontatamente contro Marta.';
    console.log(`Re-ingesting draft content: "${content}"`);
    
    const ingestRes = await client.callTool({
      name: 'novel_ingest_chapter_draft',
      arguments: {
        chapterNumber: 2,
        title: 'La rabbia di Gabriele',
        content,
        status: 'draft'
      }
    });
    
    const payload = JSON.parse(ingestRes.content[0].text);
    console.log('Ingest Response:', payload.ok ? 'SUCCESS' : 'FAILED');

    // Query Neo4j
    console.log(`Connecting to Neo4j at ${neo4jUri} to check continuity_finding nodes...`);
    const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
    const session = driver.session();
    
    try {
      const res = await session.run(`
        MATCH (cf:Entity {type: 'continuity_finding', projectId: $pid})-[r:REL {kind: 'applies_to'}]->(c:Entity {type: 'chapter', label: 'Capitolo 2'})
        RETURN cf.label as label, cf.content as content, cf.metadata as metadata
      `, { pid });
      
      console.log(`Findings linked to Capitolo 2: ${res.records.length}`);
      for (const record of res.records) {
        console.log(`- Finding Label: '${record.get('label')}'`);
        console.log(`  Message: "${record.get('content')}"`);
        console.log(`  Metadata: ${record.get('metadata')}`);
      }
    } finally {
      await session.close();
      await driver.close();
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
