import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Request, type Response } from 'express';
import { checkDataPath, config, validateConfig } from './config.js';
import * as kg from './graph/neo4jStore.js';
import { logger } from './logger.js';
import { ALL_MCP_TOOL_NAMES } from './toolNames.js';
import { registerDiagnosticTools } from './tools/diagnostics.js';
import { registerKnowledgeGraphTools } from './tools/knowledgeGraph.js';
import { registerNovelBibleTools } from './tools/novelBible.js';
import { registerNovelContextTools } from './tools/novelContext.js';
import { registerNovelEditingTools } from './tools/novelEditing.js';
import { registerNovelIngestionTools } from './tools/novelIngestion.js';
import { registerConsolidationTools } from './tools/consolidation.js';
import { registerSandboxTools } from './tools/sandbox.js';
import { registerNovelCoordinatorTools } from './tools/novelCoordinator.js';

const EMBEDDED_FALLBACK_INSTRUCTIONS = `# Rete Neurale Romanzo Gabriele MCP

Use kg_recall before writing. Do not invent canon. Keep provenance on every node and relation.`;

function loadInstructions(): string {
  const raw = process.env.MCP_INSTRUCTIONS;
  if (raw?.trim()) return raw;
  return EMBEDDED_FALLBACK_INSTRUCTIONS;
}

const mcpInstructions = loadInstructions();

function registerTools(server: McpServer): void {
  registerDiagnosticTools(server);
  registerKnowledgeGraphTools(server);
  registerNovelIngestionTools(server);
  registerNovelBibleTools(server);
  registerNovelContextTools(server);
  registerNovelEditingTools(server);
  registerConsolidationTools(server);
  registerSandboxTools(server);
  registerNovelCoordinatorTools(server);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'romanzo-gabriele-neural-mcp',
    version: config.appVersion,
    ...({ instructions: mcpInstructions } as Record<string, unknown>),
  });
  registerTools(server);
  return server;
}

function validateToolRegistry(server: McpServer): void {
  const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
  if (!registered || typeof registered !== 'object') {
    logger.warn('tool-registry: unable to introspect registered tools');
    return;
  }
  const actual = new Set(Object.keys(registered));
  const expected = new Set(ALL_MCP_TOOL_NAMES);
  const missing = [...expected].filter((name) => !actual.has(name));
  const undeclared = [...actual].filter((name) => !expected.has(name));
  if (missing.length) logger.warn('tool-registry: declared tools missing from runtime', { missing });
  if (undeclared.length) logger.warn('tool-registry: runtime tools missing from declaration list', { undeclared });
  if (!missing.length && !undeclared.length) logger.info('tool-registry: tools in sync', { count: actual.size });
}

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
};

const sessions = new Map<string, SessionEntry>();

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, entry] of sessions) {
    if (now - entry.lastActivityAt > config.sessionTtlMs) {
      sessions.delete(sessionId);
      try {
        entry.transport.close?.();
      } catch {
        // ignore
      }
    }
  }
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => message && typeof message === 'object' && (message as { method?: unknown }).method === 'initialize');
}

const app = express();
app.use(express.json({ limit: '50mb' }));

const sessionCleanupTimer = setInterval(cleanupExpiredSessions, config.sessionCleanupIntervalMs);
sessionCleanupTimer.unref();

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const body = req.body;

  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!;
    entry.lastActivityAt = Date.now();
    await entry.transport.handleRequest(req, res, body);
    return;
  }

  const isInitialize = isInitializeRequest(body);
  if (sessionId && !isInitialize) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found; reinitialize required' }, id: null });
    return;
  }
  if (!isInitialize) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Missing Mcp-Session-Id; initialize request required' }, id: null });
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: generateSessionId });
  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
  };
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    if (transport.sessionId) sessions.set(transport.sessionId, { transport, lastActivityAt: Date.now() });
  } catch (err) {
    logger.error('mcp post error', { error: String(err) });
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: String(err) }, id: null });
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const entry = sessions.get(sessionId)!;
  entry.lastActivityAt = Date.now();
  const keepAlive = setInterval(() => {
    if (res.headersSent && !res.writableEnded && !res.destroyed) {
      try {
        res.write(': keepalive\n\n');
      } catch {
        // ignore
      }
    }
  }, config.mcpSseKeepaliveMs);
  const cleanup = () => clearInterval(keepAlive);
  res.on('close', cleanup);
  res.on('finish', cleanup);
  await entry.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const entry = sessions.get(sessionId)!;
  await entry.transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

function versionInfo() {
  return {
    server: 'romanzo-gabriele-neural-mcp',
    version: config.appVersion,
    environment: config.appEnv,
    project_id: config.projectId,
    build_sha: config.buildSha,
    deployed_at: config.deployedAt,
  };
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', ...versionInfo() });
});

async function readinessBody() {
  const [neo4jConnected, storage] = await Promise.all([
    kg.pingNeo4j().then(() => true).catch(() => false),
    checkDataPath(),
  ]);
  const healthy = neo4jConnected;
  return { healthy, body: { status: healthy ? 'ok' : 'degraded', ...versionInfo(), neo4j: { connected: neo4jConnected }, storage } };
}

app.get('/readyz', async (_req, res) => {
  const { healthy, body } = await readinessBody();
  res.status(healthy ? 200 : 503).json(body);
});

app.get('/health', async (_req, res) => {
  const { healthy, body } = await readinessBody();
  res.status(healthy ? 200 : 503).json(body);
});

async function main(): Promise<void> {
  logger.info('boot: starting MCP server', versionInfo());
  const errors = validateConfig();
  if (errors.length) {
    for (const error of errors) logger.error('boot: configuration error', { error });
    process.exit(1);
  }
  try {
    validateToolRegistry(createMcpServer());
  } catch (err) {
    logger.warn('boot: tool registry validation failed', { error: String(err) });
  }
  app.listen(config.port, '0.0.0.0', () => {
    logger.info('boot: HTTP server listening', {
      port: config.port,
      mcp_endpoint: `http://0.0.0.0:${config.port}/mcp`,
    });
  });
}

process.on('SIGTERM', () => {
  void kg.closeDriver().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  void kg.closeDriver().finally(() => process.exit(0));
});

main().catch((err) => {
  logger.error('fatal error', { error: String(err) });
  process.exit(1);
});
