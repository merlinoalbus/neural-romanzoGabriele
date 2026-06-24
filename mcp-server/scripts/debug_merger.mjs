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
    console.log('=== DEBUGGING NODES BY LABEL ===');
    const labels = [
      'Tradimento di Laura e Cristiano',
      'Tradimento Cristiano con Laura',
      'Lisa Martini - Cristiano',
      'Cristiano - Con Lisa',
      'Lisa Martini - Con Cristiano',
      'Elena Costa - Lisa Martini',
      'Lisa Martini - Elena Costa',
      'Trevor Rossi (SpeedyGonzy) - Cristiano',
      'Trevor Rossi (SpeedyGonzy) - Con Cristiano',
      'Trevor Rossi (SpeedyGonzy) - Lisa Martini',
      'Trevor Rossi (SpeedyGonzy) - Con Lisa'
    ];

    for (const label of labels) {
      const res = await session.run(`MATCH (n:Entity {label: $label}) RETURN n.id as id, n.type as type, n.metadata as metadata`, { label });
      if (res.records.length > 0) {
        console.log(`Label: "${label}" | ID: ${res.records[0].get('id')} | Type: ${res.records[0].get('type')} | Metadata: ${res.records[0].get('metadata')}`);
      } else {
        console.log(`Label: "${label}" -> NOT found!`);
      }
    }

    // Try importing from dist
    console.log('\nImporting runConsolidation from dist...');
    const { runConsolidation } = await import('../dist/novel/consolidateEngine.js');
    console.log('Import successful!');
    
    console.log('\nRunning runConsolidation(true) dryRun...');
    const report = await runConsolidation(true, async (cypher, params) => {
      const s = driver.session();
      try {
        const res = await s.run(cypher, params);
        return res.records;
      } finally {
        await s.close();
      }
    });

    console.log(`Merge plans found: ${report.mergedNodes.length}`);
    for (const m of report.mergedNodes) {
      console.log(`  Target: [${m.target.type}] "${m.target.label}" (${m.target.id}) <- Merged: [${m.merged.type}] "${m.merged.label}" (${m.merged.id})`);
    }

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
