import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runConsolidation } from '../novel/consolidateEngine.js';
import { toolStructured, errorObj, toolError } from './responseHelpers.js';

export function registerConsolidationTools(server: McpServer): void {
  server.registerTool(
    'kg_run_consolidation',
    {
      title: 'Run consolidation and inference',
      description: 'Executes semantic node consolidation and relational inference.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        mergedNodes: z.array(
          z.object({
            target: z.object({ id: z.string(), type: z.string(), label: z.string() }),
            merged: z.object({ id: z.string(), type: z.string(), label: z.string() }),
          })
        ),
        inferredEdges: z.array(
          z.object({
            from: z.object({ id: z.string(), type: z.string(), label: z.string() }),
            to: z.object({ id: z.string(), type: z.string(), label: z.string() }),
            kind: z.string(),
            reason: z.string(),
          })
        ),
        stats: z.object({
          nodesBefore: z.number(),
          nodesAfter: z.number(),
          edgesBefore: z.number(),
          edgesAfter: z.number(),
        }),
        error: errorObj,
      },
      annotations: { title: 'Run consolidation and inference', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const report = await runConsolidation();
        return toolStructured(report as unknown as Record<string, unknown>);
      } catch (err) {
        return toolError('KG_CONSOLIDATION_FAILED', `kg_run_consolidation failed: ${String(err)}`);
      }
    }
  );
}
