import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export interface SavedDocumentSource {
  saved: boolean;
  path?: string;
  metadataPath?: string;
  bytes?: number;
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'document';
}

export async function saveDocumentSource(input: {
  sourceId: string;
  content?: string;
  metadata?: Record<string, unknown>;
}): Promise<SavedDocumentSource> {
  if (!input.content || !input.content.trim()) return { saved: false };
  const folder = path.join(config.projectBasePath, 'documents', safeSegment(input.sourceId));
  await fs.mkdir(folder, { recursive: true });
  const filePath = path.join(folder, 'source.txt');
  const metadataPath = path.join(folder, 'metadata.json');
  await fs.writeFile(filePath, input.content, 'utf8');
  await fs.writeFile(
    metadataPath,
    JSON.stringify({ sourceId: input.sourceId, savedAt: new Date().toISOString(), ...(input.metadata ?? {}) }, null, 2),
    'utf8',
  );
  return { saved: true, path: filePath, metadataPath, bytes: Buffer.byteLength(input.content, 'utf8') };
}
