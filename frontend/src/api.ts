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

export interface EditorChapterDraft {
  chapterNumber: number;
  sessionId: string;
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: string;
  title?: string;
  status?: string;
  wordCount?: number;
  charCount?: number;
  auditStatus?: 'pending' | 'passed' | 'failed';
  auditContentHash?: string;
  auditRevision?: number;
  auditAt?: string;
  auditError?: string;
}

export interface DraftLengthGate {
  baselineWords?: number;
  currentWords?: number;
  ok?: boolean;
  valid?: boolean;
  passed?: boolean;
  withinRange?: boolean;
  ratio?: number;
  minWords?: number;
  maxWords?: number;
  message?: string;
  [key: string]: unknown;
}

export interface EditorDraftResponse {
  draft: EditorChapterDraft;
  changed?: boolean;
  historyCount?: number;
  lengthGate?: DraftLengthGate | null;
}

export interface SaveEditorDraftInput {
  chapterNumber: number;
  sessionId: string;
  content: string;
  expectedContentHash: string;
  expectedRevision: number;
  clientMutationId?: string;
  changeSummary?: string;
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(status: number, statusText: string, payload: ApiErrorPayload | null, fallbackBody: string) {
    const message = payload?.error?.message?.trim() || `${status} ${statusText}${fallbackBody ? `: ${fallbackBody}` : ''}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code;
    this.details = payload?.error?.details;
  }
}

export interface DraftVersionConflictDetails {
  current: EditorChapterDraft;
  expectedContentHash: string;
  expectedRevision: number;
}

export class DraftVersionConflictError extends ApiError {
  readonly conflict: DraftVersionConflictDetails;

  constructor(status: number, statusText: string, payload: ApiErrorPayload, fallbackBody: string, details: DraftVersionConflictDetails) {
    super(status, statusText, payload, fallbackBody);
    this.name = 'DraftVersionConflictError';
    this.conflict = details;
  }
}

function isEditorChapterDraft(value: unknown): value is EditorChapterDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Partial<EditorChapterDraft>;
  return typeof draft.chapterNumber === 'number'
    && typeof draft.sessionId === 'string'
    && typeof draft.content === 'string'
    && typeof draft.contentHash === 'string'
    && typeof draft.revision === 'number'
    && typeof draft.updatedAt === 'string';
}

function conflictDetails(value: unknown): DraftVersionConflictDetails | null {
  if (!value || typeof value !== 'object') return null;
  const details = value as Partial<DraftVersionConflictDetails>;
  if (!isEditorChapterDraft(details.current)) return null;
  if (typeof details.expectedContentHash !== 'string' || typeof details.expectedRevision !== 'number') return null;
  return {
    current: details.current,
    expectedContentHash: details.expectedContentHash,
    expectedRevision: details.expectedRevision,
  };
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const bodyText = await response.text();
  let payload: unknown = null;
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText) as unknown;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const errorPayload = payload && typeof payload === 'object' ? payload as ApiErrorPayload : null;
    const details = response.status === 409 && errorPayload?.error?.code === 'DRAFT_VERSION_CONFLICT'
      ? conflictDetails(errorPayload.error.details)
      : null;
    if (details && errorPayload) {
      throw new DraftVersionConflictError(response.status, response.statusText, errorPayload, bodyText, details);
    }
    throw new ApiError(response.status, response.statusText, errorPayload, bodyText);
  }
  return payload as T;
}

async function getJson<T>(path: string): Promise<T> {
  return requestJson<T>(path);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function filenameFromContentDisposition(value: string | null): string {
  const match = value?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? `romanzo-gabriele-graph-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
}

export interface AppConfig {
  projectId: string;
  filesystemStorage: string;
}

export function getConfig(): Promise<AppConfig> {
  return getJson<AppConfig>('/api/config');
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

function editorDraftPath(chapterNumber: number, sessionId: string): string {
  return `/api/v2/editor/drafts/${encodeURIComponent(String(chapterNumber))}?sessionId=${encodeURIComponent(sessionId)}`;
}

export function getEditorDraft(chapterNumber: number, sessionId: string): Promise<EditorDraftResponse> {
  return getJson<EditorDraftResponse>(editorDraftPath(chapterNumber, sessionId));
}

export function saveEditorDraft(input: SaveEditorDraftInput): Promise<EditorDraftResponse> {
  const { chapterNumber, ...body } = input;
  return requestJson<EditorDraftResponse>(editorDraftPath(chapterNumber, input.sessionId), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function isDraftVersionConflict(error: unknown): error is DraftVersionConflictError {
  return error instanceof DraftVersionConflictError;
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
