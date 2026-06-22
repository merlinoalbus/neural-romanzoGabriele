import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function enabled(level: Level): boolean {
  if (config.logLevel === 'silent') return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[config.logLevel];
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (!enabled(level)) return;
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, env: config.appEnv, ...fields }) + '\n');
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
