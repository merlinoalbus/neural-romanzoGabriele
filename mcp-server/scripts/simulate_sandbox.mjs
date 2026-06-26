import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import crypto from 'node:crypto';

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
  console.log('=== NARRATIVE SANDBOX SIMULATION RUNNER ===\n');

  // 1. Connect to MCP
  console.log(`Connecting to MCP server at ${mcpUrl}...`);
  const client = new Client({ name: 'sandbox-simulation-runner', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);
  console.log('Connected to MCP server.\n');

  // 2. Connect to Neo4j
  console.log(`Connecting to Neo4j database at ${neo4jUri}...`);
  const driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  const session = driver.session();

  try {
    // 3. Generate the brief
    const characters = ['Gabriele Rinaldi (Gabriel)', 'Raphael'];
    const sceneObjective = 'Confronto tra Gabriel, ora umano, e Raphael sul senso della caduta e della mortalità.';
    
    console.log(`Generating brief for: ${characters.join(', ')}...`);
    const briefRes = await client.callTool({
      name: 'novel_create_sandbox_brief',
      arguments: { characters, sceneObjective }
    });
    
    const briefPayload = payloadOf(briefRes);
    if (!briefPayload.ok) {
      console.log('Failed brief payload:', JSON.stringify(briefPayload, null, 2));
      throw new Error(`Failed to generate brief: ${briefPayload.error?.message || JSON.stringify(briefPayload.error) || 'Unknown error'}`);
    }
    
    console.log('\n--- SIMULATION BRIEF ---');
    console.log(briefPayload.brief);
    console.log('------------------------\n');

    // 4. Define Scenarios
    const scenarios = [
      {
        name: 'Scenario 1: COHERENT DIALOGUE',
        prose: `Gabriel: Mi sento così fragile, Raphael... La mia pelle trema per questo vento freddo, e sento ogni battito del mio cuore come un timer.
Raphael: Il Padre ha voluto che tu custodissi la Sua luce, fratello. Ma stare qui sulla terra ti riempie di oscurità.`,
      },
      {
        name: 'Scenario 2: CONTRADICTORY DIALOGUE (Gabriele Shouts & Secret Exposure)',
        // Gabriele has "timido" trait. "urla" contradicts it.
        // Let's check secrets: we will also simulate Gabriele leaking something he doesn't know (if secret leak check is active)
        prose: `Gabriel si alza di scatto e urla contro Raphael, aggredendolo verbalmente.
Gabriel: Vattene! Non ho bisogno del tuo aiuto! Io sono forte!
Raphael: Sei fragile, Gabriel. Non dimenticare che il tuo destino è segnato.`,
      }
    ];

    for (const scenario of scenarios) {
      console.log(`\n=== RUNNING ${scenario.name} ===`);
      console.log(`Prose:\n"${scenario.prose}"`);

      // Run Audit Chapter tool
      console.log('Auditing dialogue prose...');
      const auditRes = await client.callTool({
        name: 'novel_audit_chapter',
        arguments: {
          chapterNumber: 99, // Dummy chapter number for sandbox
          content: scenario.prose
        }
      });

      const auditPayload = payloadOf(auditRes);
      if (!auditPayload.ok) {
        console.error('Audit failed:', auditPayload.error);
        continue;
      }

      console.log(`Audit Summary: ${auditPayload.summary?.findings || 0} findings (${auditPayload.summary?.errors || 0} errors, ${auditPayload.summary?.warnings || 0} warnings).`);
      
      const relevanceFindings = auditPayload.findings?.filter(f => f.code === 'character_trait_contradiction' || f.code === 'secret_leak_detected');
      console.log(`Relevant behavioral findings: ${relevanceFindings?.length || 0}`);
      for (const f of relevanceFindings || []) {
        console.log(`  [${f.severity.toUpperCase()}] ${f.code}: ${f.message}`);
      }

      // 5. Commit scene simulation to Neo4j
      console.log('Committing simulation log to Neo4j...');
      const sceneId = `sandbox-scene-${crypto.randomUUID().slice(0, 8)}`;
      const sceneLabel = `Simulazione Sandbox: ${scenario.name}`;
      const metadataStr = JSON.stringify({
        source: 'sandbox_simulation',
        objective: sceneObjective,
        characters,
        findingsCount: relevanceFindings?.length || 0,
        findings: relevanceFindings || []
      });
      const provenanceStr = JSON.stringify({ source: 'simulate_sandbox_script', pid });

      // Create Scene Node
      await session.run(`
        CREATE (n:Entity {
          id: $sceneId,
          type: 'scene',
          label: $sceneLabel,
          content: $prose,
          projectId: $pid,
          createdAt: toString(datetime()),
          updatedAt: toString(datetime()),
          metadata: $metadataStr,
          provenance: $provenanceStr
        })
      `, { sceneId, sceneLabel, prose: scenario.prose, pid, metadataStr, provenanceStr });

      // Link Characters to Scene
      for (const charName of characters) {
        await session.run(`
          MATCH (s:Entity {id: $sceneId, projectId: $pid})
          MATCH (c:Entity {type: 'character', label: $charName, projectId: $pid})
          CREATE (s)-[r:REL {
            id: $relId,
            kind: 'mentions',
            weight: 1.0,
            metadata: '{}',
            provenance: $provenanceStr,
            createdAt: toString(datetime())
          }]->(c)
        `, {
          sceneId,
          charName,
          pid,
          relId: `rel-scene-char-${crypto.randomUUID().slice(0, 8)}`,
          provenanceStr
        });
      }

      // Link Findings to Scene
      for (const finding of relevanceFindings || []) {
        const findingId = `finding-sandbox-${crypto.randomUUID().slice(0, 8)}`;
        const findingLabel = `${finding.code}:Sandbox`;
        const findingMetaStr = JSON.stringify({
          code: finding.code,
          severity: finding.severity,
          evidence: finding.evidence || {}
        });

        await session.run(`
          CREATE (f:Entity {
            id: $findingId,
            type: 'continuity_finding',
            label: $findingLabel,
            content: $content,
            projectId: $pid,
            createdAt: toString(datetime()),
            updatedAt: toString(datetime()),
            metadata: $findingMetaStr,
            provenance: $provenanceStr
          })
          WITH f
          MATCH (s:Entity {id: $sceneId, projectId: $pid})
          CREATE (f)-[:REL {
            id: $relId,
            kind: 'applies_to',
            weight: 1.0,
            metadata: '{}',
            provenance: $provenanceStr,
            createdAt: toString(datetime())
          }]->(s)
        `, {
          findingId,
          findingLabel,
          content: finding.message,
          pid,
          findingMetaStr,
          provenanceStr,
          sceneId,
          relId: `rel-finding-scene-${crypto.randomUUID().slice(0, 8)}`
        });
      }

      console.log(`Scenario committed successfully with scene node ID: ${sceneId}\n`);
    }

  } catch (err) {
    console.error('Error during simulation:', err);
  } finally {
    await session.close();
    await driver.close();
    await client.close();
    console.log('Sandbox simulation runner completed.');
  }
}

main().catch(console.error);
