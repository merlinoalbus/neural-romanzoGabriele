import crypto from 'node:crypto';

/** Maximum number of full-text versions retained for one chapter, current included. */
export const WORKING_DRAFT_VERSION_LIMIT = 20;
/** Previous versions stored atomically on the single current draft node. */
export const WORKING_DRAFT_RETAINED_HISTORY_LIMIT = WORKING_DRAFT_VERSION_LIMIT - 1;

export type WorkingDraftAuthor = 'ingest' | 'user' | 'llm' | 'system';
export type WorkingDraftAuditStatus = 'pending' | 'passed' | 'failed';

export interface WorkingDraftBaseline {
  contentHash: string;
  wordCount: number;
  charCount: number;
  createdAt: string;
}

export interface WorkingDraftLengthGate {
  baselineWords: number;
  currentWords: number;
  ratio: number;
  minWords: number;
  maxWords: number;
  valid: boolean;
}

export interface WorkingDraftSnapshot {
  chapterNumber: number;
  title: string;
  content: string;
  contentHash: string;
  revision: number;
  wordCount: number;
  charCount: number;
  updatedAt: string;
  updatedBy: WorkingDraftAuthor;
  draftNodeId: string;
  documentId: string;
  sourceId: string;
  /** Current graph version plus the bounded previous-version archive. */
  retainedVersionCount: number;
  /** A successful linter run must match both the current hash and monotonic revision. */
  auditStatus: WorkingDraftAuditStatus;
  auditContentHash?: string;
  auditRevision?: number;
  auditAt?: string;
  auditError?: string;
}

export interface WorkingDraftHistoryEntry {
  revision: number;
  content: string;
  contentHash: string;
  wordCount: number;
  charCount: number;
  updatedAt: string;
  updatedBy: WorkingDraftAuthor;
  clientMutationId?: string;
  changeSummary?: string;
}

export type WorkingDraftCasDecision = 'update' | 'unchanged' | 'conflict';

export function decideWorkingDraftCas(input: {
  currentContentHash: string;
  currentRevision: number;
  lastMutationId?: string;
  proposedContentHash: string;
  expectedContentHash: string;
  expectedRevision: number;
  clientMutationId?: string;
}): WorkingDraftCasDecision {
  const currentContentHash = input.currentContentHash.toLowerCase();
  const expectedContentHash = input.expectedContentHash.toLowerCase();
  const proposedContentHash = input.proposedContentHash.toLowerCase();
  const baseMatches = currentContentHash === expectedContentHash
    && input.currentRevision === input.expectedRevision;
  if (!baseMatches) {
    const directRetry = proposedContentHash === currentContentHash
      && Boolean(input.clientMutationId)
      && input.clientMutationId === input.lastMutationId;
    return directRetry ? 'unchanged' : 'conflict';
  }
  return proposedContentHash === currentContentHash ? 'unchanged' : 'update';
}

export function normalizeWorkingDraftContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export function workingDraftContentHash(content: string): string {
  return crypto.createHash('sha256').update(normalizeWorkingDraftContent(content), 'utf8').digest('hex');
}

export function workingDraftWordCount(content: string): number {
  return normalizeWorkingDraftContent(content).trim().split(/\s+/).filter(Boolean).length;
}

export function checkWorkingDraftLength(baselineWords: number, content: string): WorkingDraftLengthGate {
  const currentWords = workingDraftWordCount(content);
  const safeBaseline = Math.max(0, Math.trunc(baselineWords));
  const ratio = safeBaseline > 0 ? currentWords / safeBaseline : currentWords === 0 ? 1 : 0;
  const minWords = Math.ceil(safeBaseline * 0.85);
  const maxWords = Math.floor(safeBaseline * 1.4);
  return {
    baselineWords: safeBaseline,
    currentWords,
    ratio,
    minWords,
    maxWords,
    valid: safeBaseline === 0 ? currentWords === 0 : currentWords >= minWords && currentWords <= maxWords,
  };
}

export function isWorkingDraftAuditCurrent(input: Pick<
  WorkingDraftSnapshot,
  'auditStatus' | 'auditContentHash' | 'auditRevision' | 'contentHash' | 'revision'
>): boolean {
  return input.auditStatus === 'passed'
    && input.auditContentHash?.toLowerCase() === input.contentHash.toLowerCase()
    && input.auditRevision === input.revision;
}

export function retainWorkingDraftHistory<T>(versions: readonly T[]): T[] {
  return versions.slice(-WORKING_DRAFT_RETAINED_HISTORY_LIMIT);
}
