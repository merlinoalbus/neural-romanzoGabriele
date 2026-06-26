import { constants } from 'node:fs';
import fs from 'node:fs/promises';

function normalizeAppEnv(raw: string | undefined): 'production' | 'staging' | 'development' {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'production' || value === 'prod') return 'production';
  if (value === 'staging' || value === 'stage') return 'staging';
  return 'development';
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  projectId: process.env.PROJECT_ID || process.env.MCP_PROJECT_ID || 'romanzo-gabriele',
  port: intFromEnv('MCP_PORT', 3002),
  backendUrl: (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, ''),
  mcpSharedSecret: process.env.MCP_SHARED_SECRET || '',
  dataPath: process.env.PROJECT_BASE_PATH || '/data',
  mcpInstructionsPath: process.env.MCP_INSTRUCTIONS_PATH || './instructions.md',
  mcpSseKeepaliveMs: intFromEnv('MCP_SSE_KEEPALIVE_MS', 25_000),
  sessionTtlMs: intFromEnv('MCP_SESSION_TTL_MS', 30 * 60 * 1000),
  sessionCleanupIntervalMs: intFromEnv('MCP_SESSION_CLEANUP_INTERVAL_MS', 5 * 60 * 1000),
  neo4jUri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4jUser: process.env.NEO4J_USER || 'neo4j',
  neo4jPassword: process.env.NEO4J_PASSWORD || '',
  appEnv: normalizeAppEnv(process.env.APP_ENV),
  appVersion: process.env.APP_VERSION || process.env.npm_package_version || '0.1.0',
  buildSha: process.env.BUILD_SHA || 'unknown',
  deployedAt: process.env.DEPLOYED_AT || 'unknown',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase() as 'silent' | 'error' | 'warn' | 'info' | 'debug',
  embeddingsProvider: process.env.EMBEDDINGS_PROVIDER || ((process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY) && (process.env.EMBEDDINGS_MODEL || process.env.OPENAI_EMBEDDING_MODEL) ? 'openai-compatible' : ''),
  embeddingsApiKey: process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || '',
  embeddingsBaseUrl: (process.env.EMBEDDINGS_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  embeddingsModel: process.env.EMBEDDINGS_MODEL || process.env.OPENAI_EMBEDDING_MODEL || '',
  embeddingsDimensions: intFromEnv('EMBEDDINGS_DIMENSIONS', 0),
  embeddingsTimeoutMs: intFromEnv('EMBEDDINGS_TIMEOUT_MS', 30_000),
} as const;

export type AppEnv = typeof config.appEnv;

export function validateConfig(): string[] {
  const errors: string[] = [];
  if (!config.projectId.trim()) errors.push('PROJECT_ID must not be empty');
  if (!config.neo4jUri.trim()) errors.push('NEO4J_URI must not be empty');
  if (!config.neo4jUser.trim()) errors.push('NEO4J_USER must not be empty');
  if (config.appEnv === 'production' && !config.neo4jPassword.trim()) {
    errors.push('NEO4J_PASSWORD is required in production');
  }
  if (config.embeddingsProvider && config.embeddingsProvider !== 'openai-compatible') {
    errors.push("EMBEDDINGS_PROVIDER must be 'openai-compatible' when set");
  }
  if (config.embeddingsProvider === 'openai-compatible' && !config.embeddingsModel.trim()) {
    errors.push('EMBEDDINGS_MODEL is required when embeddings are enabled');
  }
  if (config.embeddingsProvider === 'openai-compatible' && !config.embeddingsApiKey.trim()) {
    errors.push('EMBEDDINGS_API_KEY or OPENAI_API_KEY is required when embeddings are enabled');
  }
  return errors;
}

export async function checkDataPath(): Promise<{ path: string; mounted: boolean; readable: boolean; writable: boolean }> {
  const path = config.dataPath;
  let readable = false;
  let writable = false;
  try {
    await fs.access(path, constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  try {
    await fs.access(path, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { path, mounted: readable || writable, readable, writable };
}
