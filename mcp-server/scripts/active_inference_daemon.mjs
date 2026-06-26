import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
const neo4jUri = 'bolt://localhost:7687'; // Exposed to host
const neo4jUser = process.env.NEO4J_USER || 'neo4j';
const neo4jPassword = process.env.NEO4J_PASSWORD;
const DEFAULT_MCP_URL = 'https://devrn-romanzo-mcp.nasmerlinoalbus.cloud/mcp';
const mcpUrl = process.env.MCP_URL || DEFAULT_MCP_URL;

function payloadOf(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function main() {
  console.log('=== STARTING ACTIVE INFERENCE DAEMON (SLEEP CYCLE) ===');
  
  // 1. Run MCP consolidation first
  console.log(`Connecting to MCP server at ${mcpUrl}...`);
  const client = new Client({ name: 'active-inference-daemon', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  try {
    await client.connect(transport);
    console.log('Connected! Triggering consolidation engine (dryRun: false)...');
    const res = await client.callTool({
      name: 'kg_run_consolidation',
      arguments: { dryRun: false }
    });
    const payload = payloadOf(res);
    if (payload.ok) {
      console.log(`Consolidation completed: Merged ${payload.report?.merges?.length || 0} duplicates, inferred ${payload.report?.inferredRelationships?.length || 0} relationships.`);
    } else {
      console.log('Consolidation returned non-ok result:', payload);
    }
  } catch (err) {
    console.error('MCP consolidation failed:', err.message);
  } finally {
    await client.close();
  }

  // 2. Connect to Neo4j to execute advanced inference rules
  console.log(`Connecting to Neo4j at ${neo4jUri}...`);
  if (!neo4jPassword) {
    console.error('NEO4J_PASSWORD not found in environment. Exiting.');
    return;
  }
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();

  try {
    // --- RULE 1: Transitive Distrust ---
    console.log('Running Rule 1: Transitive Distrust detection...');
    const distrustRes = await session.run(`
      MATCH (c1:Entity {type:'character', projectId:$pid})-[r1:hates|rival_of|opposes|enemy_of]-(c2:Entity {type:'character', projectId:$pid})
      MATCH (c2)-[r2:ally_of|member_of|friend_of|allied_with]-(c3:Entity {type:'character', projectId:$pid})
      WHERE c1 <> c3
      AND NOT (c1)-[:distrusts|hates|rival_of|opposes|enemy_of]-(c3)
      RETURN c1.id as c1Id, c1.label as c1Label, c3.id as c3Id, c3.label as c3Label, c2.label as c2Label, type(r1) as r1Kind, type(r2) as r2Kind
    `, { pid });

    console.log(`Matched transitive conflict patterns: ${distrustRes.records.length}`);
    for (const record of distrustRes.records) {
      const c1Id = record.get('c1Id');
      const c1Label = record.get('c1Label');
      const c3Id = record.get('c3Id');
      const c3Label = record.get('c3Label');
      const c2Label = record.get('c2Label');
      const r1Kind = record.get('r1Kind');
      const r2Kind = record.get('r2Kind');

      const candidateId = `candidate-distrust-${c1Label.replace(/\s+/g, '')}-${c3Label.replace(/\s+/g, '')}`;
      const candidateLabel = `Ipotesi: ${c1Label} diffida di ${c3Label}`;
      const content = `Suggerimento di inferenza attiva: ${c1Label} potrebbe diffidare di ${c3Label} poiché quest'ultimo è legato da relazione '${r2Kind}' a ${c2Label}, con cui ${c1Label} ha un rapporto di tipo '${r1Kind}'.`;
      
      const metadataStr = JSON.stringify({
        source: 'active_inference',
        candidateType: 'relationship',
        fromId: c1Id,
        toId: c3Id,
        kind: 'distrusts'
      });
      const provenanceStr = JSON.stringify({ source: 'active_inference_daemon', pid });

      console.log(`  -> Creating candidate: "${candidateLabel}"`);
      await session.run(`
        MERGE (n:Entity {id: $candidateId})
        ON CREATE SET
          n.type = 'bible_candidate',
          n.label = $candidateLabel,
          n.content = $content,
          n.projectId = $pid,
          n.createdAt = toString(datetime()),
          n.updatedAt = toString(datetime()),
          n.metadata = $metadataStr,
          n.provenance = $provenanceStr
        ON MATCH SET
          n.updatedAt = toString(datetime())
        WITH n
        MATCH (from:Entity {id: $c1Id})
        MATCH (to:Entity {id: $c3Id})
        MERGE (n)-[r1:REL {kind: 'applies_to'}]->(from)
        ON CREATE SET r1.id = $relId1, r1.createdAt = toString(datetime()), r1.metadata = '{}', r1.provenance = $provenanceStr
        MERGE (n)-[r2:REL {kind: 'applies_to'}]->(to)
        ON CREATE SET r2.id = $relId2, r2.createdAt = toString(datetime()), r2.metadata = '{}', r2.provenance = $provenanceStr
      `, {
        candidateId,
        candidateLabel,
        content,
        pid,
        c1Id,
        c3Id,
        metadataStr,
        provenanceStr,
        relId1: 'rel-ai-' + Math.random().toString(36).substring(2, 10),
        relId2: 'rel-ai-' + Math.random().toString(36).substring(2, 10)
      });
    }

    // --- RULE 2: Inactive Plot Threads ---
    console.log('Running Rule 2: Inactive Plot Threads detection...');
    const threadRes = await session.run(`
      MATCH (pt:Entity {type:'plot_thread', projectId:$pid})
      WHERE NOT (pt)-[:about|applies_to|part_of|has_theme]-(:Entity {type:'timeline_event'})
      RETURN pt.id as id, pt.label as label
    `, { pid });

    console.log(`Matched inactive plot threads: ${threadRes.records.length}`);
    for (const record of threadRes.records) {
      const ptId = record.get('id');
      const ptLabel = record.get('label');

      const findingId = `finding-inactive-thread-${ptLabel.replace(/\s+/g, '')}`;
      const findingLabel = `plot_thread_inactive:${ptLabel}`;
      const content = `Avviso del cervello narrativo: Il filo conduttore '${ptLabel}' non è collegato a nessun evento della timeline. Suggeriamo di pianificare un evento per sviluppare questa linea narrativa.`;

      const metadataStr = JSON.stringify({
        code: 'inactive_plot_thread',
        severity: 'warning',
        plotThreadId: ptId
      });
      const provenanceStr = JSON.stringify({ source: 'active_inference_daemon', pid });

      console.log(`  -> Creating warning finding: "${findingLabel}"`);
      await session.run(`
        MERGE (n:Entity {id: $findingId})
        ON CREATE SET
          n.type = 'continuity_finding',
          n.label = $findingLabel,
          n.content = $content,
          n.projectId = $pid,
          n.createdAt = toString(datetime()),
          n.updatedAt = toString(datetime()),
          n.metadata = $metadataStr,
          n.provenance = $provenanceStr
        ON MATCH SET
          n.updatedAt = toString(datetime())
        WITH n
        MATCH (pt:Entity {id: $ptId})
        MERGE (n)-[r:REL {kind: 'applies_to'}]->(pt)
        ON CREATE SET r.id = $relId, r.createdAt = toString(datetime()), r.metadata = '{}', r.provenance = $provenanceStr
      `, {
        findingId,
        findingLabel,
        content,
        pid,
        ptId,
        metadataStr,
        provenanceStr,
        relId: 'rel-ai-' + Math.random().toString(36).substring(2, 10)
      });
    }

    console.log('Active inference daemon finished successfully.');
  } catch (err) {
    console.error('Error running active inference daemon:', err);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
