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

export interface OpenPoint {
  finding: KgNode;
  plotThread: KgNode | null;
}

export interface GraphSnapshot {
  schemaVersion: string;
  projectId: string;
  exportedAt: string;
  appVersion: string;
  counts: {
    nodes: number;
    edges: number;
  };
  nodes: KgNode[];
  edges: KgEdge[];
}

export type ImportMode = 'upsert' | 'replaceProject';

export interface SnapshotValidationReport {
  ok: boolean;
  schemaVersion?: string;
  sourceProjectId?: string;
  targetProjectId: string;
  mode: ImportMode;
  dryRun: boolean;
  counts: {
    nodes: number;
    edges: number;
    currentNodes: number;
    currentEdges: number;
  };
  errors: string[];
  warnings: string[];
}

export interface SnapshotImportResult {
  ok: boolean;
  dryRun: boolean;
  mode: ImportMode;
  report: SnapshotValidationReport;
  written?: {
    nodes: number;
    edges: number;
  };
}

export interface ChapterSummary {
  id: string;
  label: string;
  number: number | null;
  title: string;
  date: string | null;
  timePlane: string | null;
  chapterKind: string | null;
  documentChapterLabel: string | null;
  primarySectionKey: string | null;
  frameOrder: number | null;
  role?: 'prologo' | 'epilogo';
}

export interface ChapterRelation {
  node: KgNode;
  kind: string;
  direction: 'out' | 'in';
}

export interface ChapterMention {
  fromId: string;
  fromLabel: string;
  fromType: string;
  fromSection: string | null;
  refType: string | null;
  originalCitation: string | null;
}

export interface ChapterPacket {
  chapter: KgNode | null;
  prev: ChapterSummary[];
  next: ChapterSummary[];
  touches: ChapterRelation[];
  incomingMentions: ChapterMention[];
}

export interface EntityPacket {
  node: KgNode | null;
  touches: ChapterRelation[];
  incomingMentions: ChapterMention[];
}

export interface TimelineEntry {
  id: string;
  label: string;
  content: string;
  chapterId: string | null;
  chapterNumber: number | null;
  chapterTitle: string | null;
  date: string | null;
  timePlane: string | null;
}

export interface HealthReport {
  totals: { nodes: number; edges: number };
  nodeTypes: Record<string, number>;
  edgeKinds: Record<string, number>;
  relatedToEdges: number;
  orphanNodes: number;
  chaptersMissingDate: number;
  timelineUnanchored: number;
  openPoints: number;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

function filenameFromContentDisposition(value: string | null): string {
  const match = value?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? `romanzo-gabriele-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
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

export function listKgNodes(limit = 80, type?: string): Promise<{ nodes: KgNode[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set('type', type);
  return getJson<{ nodes: KgNode[] }>(`/api/v2/kg/nodes?${params.toString()}`);
}

export function listKgOpenPoints(limit = 120): Promise<{ points: OpenPoint[] }> {
  return getJson<{ points: OpenPoint[] }>(`/api/v2/kg/open-points?limit=${limit}`);
}

export function listChapters(): Promise<{ chapters: ChapterSummary[] }> {
  return getJson<{ chapters: ChapterSummary[] }>('/api/v2/novel/chapters');
}

export function getChapterPacket(id: string): Promise<ChapterPacket> {
  return getJson<ChapterPacket>(`/api/v2/novel/chapter?id=${encodeURIComponent(id)}`);
}

export function getEntityPacket(id: string): Promise<EntityPacket> {
  return getJson<EntityPacket>(`/api/v2/novel/entity?id=${encodeURIComponent(id)}`);
}

export function getTimeline(): Promise<{ entries: TimelineEntry[] }> {
  return getJson<{ entries: TimelineEntry[] }>('/api/v2/novel/timeline');
}

export function getHealth(): Promise<HealthReport> {
  return getJson<HealthReport>('/api/v2/novel/health');
}

export async function exportGraphSnapshot(): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch('/api/v2/admin/export', {
    headers: {
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  return {
    blob: await response.blob(),
    filename: filenameFromContentDisposition(response.headers.get('Content-Disposition')),
  };
}

export function dryRunGraphSnapshotImport(snapshot: GraphSnapshot, mode: ImportMode): Promise<SnapshotImportResult> {
  return postJson<SnapshotImportResult>('/api/v2/admin/import/dry-run', { snapshot, mode });
}

export function commitGraphSnapshotImport(
  snapshot: GraphSnapshot,
  mode: ImportMode,
  confirmProjectId?: string,
): Promise<SnapshotImportResult> {
  return postJson<SnapshotImportResult>('/api/v2/admin/import/commit', { snapshot, mode, confirmProjectId });
}
