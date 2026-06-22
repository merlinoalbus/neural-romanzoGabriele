import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  port: intFromEnv('PORT', 3001),
  projectId: process.env.PROJECT_ID || 'romanzo-gabriele',
  projectBasePath: path.resolve(process.env.PROJECT_BASE_PATH || '/data'),
  mcpSharedSecret: process.env.MCP_SHARED_SECRET || '',
  appEnv: normalizeAppEnv(process.env.APP_ENV),
  appVersion: process.env.APP_VERSION || process.env.npm_package_version || '0.1.0',
  buildSha: process.env.BUILD_SHA || 'unknown',
  deployedAt: process.env.DEPLOYED_AT || 'unknown',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase() as 'silent' | 'error' | 'warn' | 'info' | 'debug',
  neo4j: {
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || '',
  },
} as const;

export function validateConfig(): string[] {
  const errors: string[] = [];
  if (!config.projectId.trim()) errors.push('PROJECT_ID must not be empty');
  if (!config.projectBasePath) errors.push('PROJECT_BASE_PATH is required');
  if (config.appEnv === 'production' && !config.neo4j.password.trim()) {
    errors.push('NEO4J_PASSWORD is required in production');
  }
  return errors;
}

export async function checkDataPath(): Promise<{ path: string; mounted: boolean; readable: boolean; writable: boolean }> {
  let readable = false;
  let writable = false;
  try {
    await fs.access(config.projectBasePath, constants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  try {
    await fs.access(config.projectBasePath, constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { path: config.projectBasePath, mounted: readable || writable, readable, writable };
}
