import cors from 'cors';
import express from 'express';
import { checkDataPath, config, validateConfig } from './config.js';
import { logger } from './logger.js';
import documentsRouter from './routes/documents.js';
import kgRouter from './routes/kg.js';
import * as kg from './services/neo4jReadService.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use('/api/v2/kg', kgRouter);
app.use('/api/v2/documents', documentsRouter);

app.get('/api/config', (_req, res) => {
  res.json({ projectId: config.projectId, projectBasePath: config.projectBasePath });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    server: 'neural-graph-platform-server',
    version: config.appVersion,
    environment: config.appEnv,
    project_id: config.projectId,
    build_sha: config.buildSha,
    deployed_at: config.deployedAt,
  });
});

app.get('/readyz', async (_req, res) => {
  const [neo4jConnected, storage] = await Promise.all([
    kg.pingNeo4j().then(() => true).catch(() => false),
    checkDataPath(),
  ]);
  const healthy = neo4jConnected && storage.readable && storage.writable;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    server: 'neural-graph-platform-server',
    version: config.appVersion,
    environment: config.appEnv,
    project_id: config.projectId,
    neo4j: { connected: neo4jConnected },
    storage,
  });
});

app.get('/health', async (_req, res) => {
  const [neo4jConnected, storage] = await Promise.all([
    kg.pingNeo4j().then(() => true).catch(() => false),
    checkDataPath(),
  ]);
  const healthy = neo4jConnected && storage.readable && storage.writable;
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', neo4j: { connected: neo4jConnected }, storage });
});

async function main(): Promise<void> {
  const errors = validateConfig();
  if (errors.length) {
    for (const error of errors) logger.error('configuration error', { error });
    process.exit(1);
  }
  app.listen(config.port, '0.0.0.0', () => logger.info('server listening', { port: config.port }));
}

process.on('SIGTERM', () => void kg.closeDriver().finally(() => process.exit(0)));
process.on('SIGINT', () => void kg.closeDriver().finally(() => process.exit(0)));

main().catch((err) => {
  logger.error('fatal error', { error: String(err) });
  process.exit(1);
});
