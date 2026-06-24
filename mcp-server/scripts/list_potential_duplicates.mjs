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
    const allNodesRes = await session.run(`
      MATCH (n:Entity {projectId: $pid})
      RETURN n.id as id, n.type as type, n.label as label
    `, { pid });
    
    const nodes = allNodesRes.records.map(r => ({
      id: r.get('id'),
      type: r.get('type'),
      label: r.get('label')
    }));

    const cleanWordSet = (str) => {
      return new Set(str.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2));
    };

    const jaccard = (setA, setB) => {
      if (setA.size === 0 || setB.size === 0) return 0;
      let intersection = 0;
      for (const el of setA) {
        if (setB.has(el)) intersection++;
      }
      return intersection / (setA.size + setB.size - intersection);
    };

    const duplicatePairs = [];
    for (let i = 0; i < nodes.length; i++) {
      const n1 = nodes[i];
      const words1 = cleanWordSet(n1.label);
      for (let j = i + 1; j < nodes.length; j++) {
        const n2 = nodes[j];
        if (n1.type === n2.type) {
          const words2 = cleanWordSet(n2.label);
          const sim = jaccard(words1, words2);
          if (sim > 0.6 && n1.label !== n2.label) {
            duplicatePairs.push({ n1, n2, similarity: sim });
          }
        }
      }
    }

    console.log(`Found ${duplicatePairs.length} potential duplicate pairs (Jaccard similarity > 60%):`);
    for (const p of duplicatePairs) {
      console.log(`  * [${p.n1.type}] "${p.n1.label}" [${p.n1.id}] AND "${p.n2.label}" [${p.n2.id}] (Sim: ${(p.similarity*100).toFixed(1)}%)`);
    }

    // Let's also check for exact duplicate labels but with different casing/accents or spacing (already caught by implicit merge, but let's see if there are any that are blocked due to conflicting IDs)
    const normMap = new Map();
    const caseDuplicates = [];
    for (const n of nodes) {
      const norm = n.type + '::' + n.label.toLowerCase().trim();
      if (normMap.has(norm)) {
        caseDuplicates.push({ n1: normMap.get(norm), n2: n });
      } else {
        normMap.set(norm, n);
      }
    }
    console.log(`\nFound ${caseDuplicates.length} case/whitespace duplicate pairs:`);
    for (const p of caseDuplicates) {
      console.log(`  * [${p.n1.type}] "${p.n1.label}" [${p.n1.id}] AND "${p.n2.label}" [${p.n2.id}]`);
    }

  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(console.error);
