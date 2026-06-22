import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkDataPath, config } from '../config.js';
import * as kg from '../graph/neo4jStore.js';
import { toolStructured } from './responseHelpers.js';

const envEnum = z.enum(['production', 'staging', 'development']);

const toolSummaryShape = {
  name: z.string(),
  read_only: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  has_input_schema: z.boolean(),
  has_output_schema: z.boolean(),
};

export function registerDiagnosticTools(server: McpServer): void {
  server.registerTool(
    'ping',
    {
      title: 'Ping',
      description: 'Verifies that the MCP server is reachable. Read-only and does not touch Neo4j.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        server: z.string(),
        version: z.string(),
        environment: envEnum,
        projectId: z.string(),
        timestamp: z.string(),
      },
      annotations: { title: 'Ping', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => toolStructured({
      ok: true,
      message: 'pong',
      server: 'romanzo-gabriele-neural-mcp',
      version: config.appVersion,
      environment: config.appEnv,
      projectId: config.projectId,
      timestamp: new Date().toISOString(),
    }),
  );

  server.registerTool(
    'get_server_status',
    {
      title: 'Server status',
      description: 'Checks Neo4j connectivity and NAS/data-path accessibility. Read-only.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        neo4j: z.object({ connected: z.boolean() }),
        storage: z.object({ path: z.string(), mounted: z.boolean(), readable: z.boolean(), writable: z.boolean() }),
        version: z.string(),
        environment: envEnum,
        projectId: z.string(),
      },
      annotations: { title: 'Server status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const [neo4jConnected, storage] = await Promise.all([
        kg.pingNeo4j().then(() => true).catch(() => false),
        checkDataPath(),
      ]);
      return toolStructured({
        ok: neo4jConnected && storage.readable,
        neo4j: { connected: neo4jConnected },
        storage,
        version: config.appVersion,
        environment: config.appEnv,
        projectId: config.projectId,
      });
    },
  );

  server.registerTool(
    'list_mcp_capabilities',
    {
      title: 'List MCP capabilities',
      description: 'Returns a compact summary of every registered tool and its safety annotations. Read-only.',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), tools_count: z.number().int().nonnegative(), tools: z.array(z.object(toolSummaryShape)) },
      annotations: { title: 'List MCP capabilities', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      type RegisteredToolEntry = {
        annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
        inputSchema?: unknown;
        outputSchema?: unknown;
      };
      let registered: Record<string, RegisteredToolEntry> = {};
      try {
        const priv = (server as unknown as { _registeredTools?: Record<string, RegisteredToolEntry> })._registeredTools;
        if (priv && typeof priv === 'object') registered = priv;
      } catch {
        registered = {};
      }
      const tools = Object.keys(registered).sort().map((name) => {
        const tool = registered[name];
        const ann = tool?.annotations ?? {};
        return {
          name,
          read_only: Boolean(ann.readOnlyHint),
          destructive: Boolean(ann.destructiveHint),
          idempotent: Boolean(ann.idempotentHint),
          has_input_schema: tool?.inputSchema !== undefined && tool?.inputSchema !== null,
          has_output_schema: tool?.outputSchema !== undefined && tool?.outputSchema !== null,
        };
      });
      return toolStructured({ ok: true, tools_count: tools.length, tools });
    },
  );
}
