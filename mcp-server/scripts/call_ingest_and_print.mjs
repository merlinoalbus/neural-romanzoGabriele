import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_MCP_URL = 'https://devrn-romanzo-mcp.nasmerlinoalbus.cloud/mcp';
const mcpUrl = process.env.MCP_URL || DEFAULT_MCP_URL;

async function main() {
  const client = new Client({ name: 'call-ingest-print', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  await client.connect(transport);

  try {
    const content = 'Gabriele Rinaldi (Gabriel) si alza in piedi di scatto e urla sfrontatamente contro Marta.';
    console.log('Calling novel_ingest_chapter_draft...');
    const res = await client.callTool({
      name: 'novel_ingest_chapter_draft',
      arguments: {
        chapterNumber: 2,
        title: 'La rabbia di Gabriele',
        content,
        status: 'draft'
      }
    });
    console.log('Full Tool Response:');
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
