export interface KgNode {
  id: string;
  type: string;
  label: string;
  content: string;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface KgEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
  metadata: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface KgStats {
  nodes: number;
  edges: number;
  nodeTypes: Record<string, number>;
  edgeKinds: Record<string, number>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export function getKgStats(): Promise<KgStats> {
  return getJson<KgStats>('/api/v2/kg/stats');
}

export function searchKg(q: string, type?: string, limit?: number): Promise<{ nodes: KgNode[] }> {
  const params = new URLSearchParams({ q });
  if (type) params.set('type', type);
  if (limit) params.set('limit', String(limit));
  return getJson<{ nodes: KgNode[] }>(`/api/v2/kg/search?${params.toString()}`);
}

export function getKgNeighbors(id: string, depth?: number): Promise<{ nodes: KgNode[]; edges: KgEdge[] }> {
  const params = new URLSearchParams({ id });
  if (depth) params.set('depth', String(depth));
  return getJson<{ nodes: KgNode[]; edges: KgEdge[] }>(`/api/v2/kg/neighbors?${params.toString()}`);
}

export function getKgNode(id: string): Promise<{ node: KgNode | null }> {
  return getJson<{ node: KgNode | null }>(`/api/v2/kg/node?id=${encodeURIComponent(id)}`);
}

export function listKgDocuments(limit = 50): Promise<{ documents: KgNode[] }> {
  return getJson<{ documents: KgNode[] }>(`/api/v2/kg/documents?limit=${limit}`);
}
