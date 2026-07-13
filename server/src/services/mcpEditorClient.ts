import { config } from '../config.js';

export interface EditorProxyResponse {
  status: number;
  payload: unknown;
}

export async function requestMcpEditor(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<EditorProxyResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Source': 'frontend-backend',
  };
  if (config.mcpSharedSecret) headers['X-Source-Secret'] = config.mcpSharedSecret;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${config.mcpEditorUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { error: { code: 'MCP_EDITOR_INVALID_RESPONSE', message: text } };
    }
  }
  return { status: response.status, payload };
}
