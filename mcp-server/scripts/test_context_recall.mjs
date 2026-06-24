import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcpUrl = 'http://127.0.0.1:13004/mcp';

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

async function testRecall(task, query = undefined, chapterNumber = undefined) {
  console.log(`\n=== Calling novel_recall_context for: task="${task}", query="${query}", chapter=${chapterNumber} ===`);
  const client = new Client({ name: 'test-recall-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));

  try {
    await client.connect(transport);
    const res = await client.callTool({
      name: 'novel_recall_context',
      arguments: { task, query, chapterNumber, depth: 2, limit: 30 }
    });
    const payload = payloadOf(res);
    if (payload.ok && payload.context) {
      console.log('--- RECALL SUCCESS ---');
      const ctx = payload.context;
      
      console.log('\nRecalled Locations:');
      if (ctx.locations && ctx.locations.length > 0) {
        for (const loc of ctx.locations) console.log(`  - [${loc.id}] ${loc.label}`);
      } else {
        console.log('  None');
      }

      console.log('\nRecalled Themes:');
      if (ctx.themes && ctx.themes.length > 0) {
        for (const t of ctx.themes) console.log(`  - [${t.id}] ${t.label}`);
      } else {
        console.log('  None');
      }

      console.log('\nRecalled Traits:');
      if (ctx.characterTraits && ctx.characterTraits.length > 0) {
        for (const tr of ctx.characterTraits) console.log(`  - [${tr.id}] ${tr.label}`);
      } else {
        console.log('  None');
      }

      console.log('\nRecalled Bible Claims:');
      if (ctx.bibleClaims && ctx.bibleClaims.length > 0) {
        for (const c of ctx.bibleClaims) console.log(`  - [${c.id}] ${c.label}`);
      } else {
        console.log('  None');
      }

      console.log('\nRecalled Timeline Events:');
      if (ctx.timelineEvents && ctx.timelineEvents.length > 0) {
        for (const ev of ctx.timelineEvents) console.log(`  - [${ev.id}] ${ev.label}: ${ev.content.substring(0, 100)}...`);
      } else {
        console.log('  None');
      }
    } else {
      console.error('Recall failed or returned no context:', payload);
    }
  } catch (err) {
    console.error('Error during recall test:', err);
  } finally {
    await client.close();
  }
}

async function main() {
  await testRecall("Ricerca scontro corridoio Cristiano capitolo 2", undefined, 2);
  await testRecall("Scultura garage capitolo 4", undefined, 4);
}

main().catch(console.error);
