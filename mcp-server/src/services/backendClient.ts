import { config } from '../config.js';

export interface SavedDocumentSource {
  saved: boolean;
  path?: string;
  metadataPath?: string;
  bytes?: number;
  error?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Source': 'mcp',
  };
  if (config.mcpSharedSecret) headers['X-Source-Secret'] = config.mcpSharedSecret;
  const response = await fetch(`${config.backendUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function saveDocumentSource(input: {
  sourceId: string;
  content?: string;
  metadata?: Record<string, unknown>;
}): Promise<SavedDocumentSource> {
  if (!input.content?.trim()) return { saved: false };
  return postJson<SavedDocumentSource>('/api/v2/documents/source', input);
}
