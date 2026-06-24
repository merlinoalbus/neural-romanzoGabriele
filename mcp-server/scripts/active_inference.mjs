import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcpUrl = process.env.MCP_URL || 'http://127.0.0.1:13004/mcp';

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
  console.log(`Connecting to narrative brain at: ${mcpUrl}...`);
  const client = new Client({ name: 'romanzo-gabriele-neural-active-inference', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  await client.connect(transport);
  console.log('Connected! Querying graph state...\n');

  try {
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      return payloadOf(result);
    };

    // 1. Stats
    const stats = await call('kg_stats');
    console.log('=== GRAPH STATISTICS ===');
    console.log(`Nodes: ${stats.nodes}`);
    console.log(`Edges: ${stats.edges}`);
    console.log('\n');

    // 2. Find traits and secrets in DB
    console.log('=== SEARCHING REAL CHARACTER TRAITS & SECRETS ===');
    const traitSearch = await call('kg_search', { query: 'e', type: 'character_trait', limit: 5 });
    const traitsFound = traitSearch.nodes || [];
    console.log(`Traits Found: ${traitsFound.length}`);
    for (const t of traitsFound) {
      console.log(`  - Trait: '${t.label}' (${t.content})`);
    }

    const secretSearch = await call('kg_search', { query: 'e', type: 'secret', limit: 5 });
    const secretsFound = secretSearch.nodes || [];
    console.log(`Secrets Found: ${secretsFound.length}`);
    for (const s of secretsFound) {
      console.log(`  - Secret: '${s.label}' (${s.content})`);
    }
    console.log('\n');

    // 3. Consolidation & Inference (Dry Run)
    console.log('=== RUNNING CONSOLIDATION & INFERENCE (DRY RUN) ===');
    const consolidation = await call('kg_run_consolidation', { dryRun: true });
    console.log(`Merge Candidates Found: ${consolidation.report?.merges?.length || 0}`);
    console.log(`Inferred Relationships: ${consolidation.report?.inferredRelationships?.length || 0}`);
    for (const rel of consolidation.report?.inferredRelationships || []) {
      console.log(`  - Inferred: '${rel.fromLabel}' -[${rel.kind}]-> '${rel.toLabel}'`);
    }
    console.log('\n');

    // 4. Narrative Audit / Coherence Linter Demo using real characters
    console.log('=== RUNNING COHERENCE LINTER DEMO ===');
    const demoAudit = await call('novel_audit_chapter', {
      chapterNumber: 2,
      content: 'Gabriele Rinaldi (Gabriel) si alza in piedi e urla sfacciatamente contro il suo riflesso nel silenzio della notte, parlando apertamente della metamorfosi.',
    });
    console.log(`Findings Detected: ${demoAudit.findings?.length || 0}`);
    for (const finding of demoAudit.findings || []) {
      console.log(`  [${finding.severity.toUpperCase()}] (${finding.code}): ${finding.message}`);
    }
    console.log('\n');

    // 5. Sandbox Brief Demo using real characters
    console.log('=== RUNNING SANDBOX BRIEF GENERATION DEMO ===');
    const sandboxBrief = await call('novel_create_sandbox_brief', {
      characters: ['Gabriele Rinaldi (Gabriel)', 'Raphael'],
      sceneObjective: 'Un confronto notturno sul destino degli angeli decaduti.',
    });
    console.log('Generated Sandbox Brief Preview:');
    if (sandboxBrief.brief) {
      console.log(sandboxBrief.brief);
    } else {
      console.log('No brief generated:', sandboxBrief);
    }
    console.log('\n');

  } catch (err) {
    console.error('Error during active inference session:', err);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
