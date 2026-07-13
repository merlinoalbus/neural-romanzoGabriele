import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ChapterSectionRole, EditorialDecisionStatus, EditorialFindingCategory } from './domain.js';
import type { ChapterBlock, RewriteLengthCheck } from './editingWorkflow.js';
import {
  workingDraftContentHash as computeWorkingDraftContentHash,
  workingDraftWordCount,
} from './workingDraft.js';

/**
 * Editorial work-in-progress (session, blocks, findings, decisions, rewrites, seam review,
 * visual briefs and length-gate baseline) is never a graph node. Neo4j contains only one
 * current `chapter_draft` projection with its bounded atomic history; this store persists the
 * remaining working state as one JSON file per session,
 * mirroring the file-based bookkeeping the Bible pipeline already uses for its own progress
 * tracking. The file is deleted once `novel_save_final_chapter` canonizes the chapter.
 */

export interface EditorialFindingRecord {
  id: string;
  step: string;
  blockNumber?: number;
  category: EditorialFindingCategory;
  severity: 'info' | 'warning' | 'error';
  originalText?: string;
  problem: string;
  suggestion?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface EditorialDecisionRecord {
  findingId: string;
  status: EditorialDecisionStatus;
  reason?: string;
  instructions?: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface RewriteBlockRecord {
  blockNumber: number;
  revisedText: string;
  originalHash: string;
  revisedHash: string;
  lengthCheck: RewriteLengthCheck;
  appliedFindingIds: string[];
  approved: boolean;
  updatedAt: string;
}

export interface SeamReviewRecord {
  summary: string;
  findings: string[];
  approved: boolean;
  updatedAt: string;
}

export interface VisualBriefRecord {
  sceneSummary: string;
  characters: string[];
  promptIt: string;
  promptEn?: string;
  styleModifier?: string;
  sourceText?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AssembledRevisionRecord {
  content: string;
  blockCount: number;
  assembledAt: string;
}

export interface WorkingDraftBaseline {
  contentHash: string;
  wordCount: number;
  charCount: number;
  /** Binds the session to one concrete graph draft generation across cleanup/re-ingest cycles. */
  draftNodeId?: string;
  createdAt: string;
}

export interface EditingSessionFinalizationOutcome<T> {
  /** Delete the session only after all external finalization work has succeeded. */
  finalized: boolean;
  value: T;
}

export interface EditingSessionState {
  sessionId: string;
  /** Present for a numbered chapter; absent for Prologo/Epilogo, which use `role` instead. */
  chapterNumber?: number;
  role?: ChapterSectionRole;
  title?: string;
  manuscriptId?: string;
  draftId?: string;
  notes?: string;
  status: 'active' | 'closed';
  blocks: ChapterBlock[];
  findings: EditorialFindingRecord[];
  decisions: EditorialDecisionRecord[];
  rewrites: RewriteBlockRecord[];
  seamReview: SeamReviewRecord | null;
  visualBriefs: VisualBriefRecord[];
  assembledRevision: AssembledRevisionRecord | null;
  /** Immutable hash/count reference used for length gates; it contains no extra prose copy. */
  workingDraftBaseline: WorkingDraftBaseline | null;
  createdAt: string;
  updatedAt: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const sessionLocks = new Map<string, Promise<void>>();

export class EditingSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`editing_session_not_found: ${sessionId}`);
  }
}

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`invalid_session_id: ${sessionId}`);
}

function stateDir(): string {
  return path.resolve(config.editingStateDir);
}

function sessionPath(sessionId: string): string {
  assertValidSessionId(sessionId);
  return path.join(stateDir(), `${sessionId}.json`);
}

function wordCount(content: string): number {
  return workingDraftWordCount(content);
}

function snapshotFields(content: string, createdAt: string): WorkingDraftBaseline {
  return {
    contentHash: computeWorkingDraftContentHash(content),
    wordCount: wordCount(content),
    charCount: content.length,
    createdAt,
  };
}

function normalizeBaseline(value: unknown, fallbackCreatedAt: string): WorkingDraftBaseline | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<WorkingDraftBaseline> & { content?: unknown };
  const legacyContent = typeof record.content === 'string' ? record.content : '';
  if (!(typeof record.contentHash === 'string' && record.contentHash) && !legacyContent) return null;
  return {
    contentHash: typeof record.contentHash === 'string' && record.contentHash ? record.contentHash : computeWorkingDraftContentHash(legacyContent),
    wordCount: typeof record.wordCount === 'number' ? record.wordCount : wordCount(legacyContent),
    charCount: typeof record.charCount === 'number' ? record.charCount : legacyContent.length,
    draftNodeId: typeof record.draftNodeId === 'string' && record.draftNodeId ? record.draftNodeId : undefined,
    createdAt: typeof record.createdAt === 'string' && record.createdAt ? record.createdAt : fallbackCreatedAt,
  };
}

function normalizeEditingSessionState(value: EditingSessionState): EditingSessionState {
  const fallbackTimestamp = typeof value.updatedAt === 'string' && value.updatedAt
    ? value.updatedAt
    : typeof value.createdAt === 'string' && value.createdAt
      ? value.createdAt
      : new Date().toISOString();
  const workingDraftBaseline = normalizeBaseline(value.workingDraftBaseline, fallbackTimestamp);
  // Older builds stored full-text revisions in the session JSON. Drop that legacy field on the
  // next read/write: the single graph draft now owns the global, atomically bounded history.
  const { workingDraftRevisions: _discardedLegacyHistory, ...stateWithoutLegacyHistory } = value as EditingSessionState & {
    workingDraftRevisions?: unknown;
  };
  void _discardedLegacyHistory;
  return {
    ...stateWithoutLegacyHistory,
    status: value.status === 'closed' ? 'closed' : 'active',
    blocks: Array.isArray(value.blocks) ? value.blocks : [],
    findings: Array.isArray(value.findings) ? value.findings : [],
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    rewrites: Array.isArray(value.rewrites) ? value.rewrites : [],
    seamReview: value.seamReview ?? null,
    visualBriefs: Array.isArray(value.visualBriefs) ? value.visualBriefs : [],
    assembledRevision: value.assembledRevision ?? null,
    workingDraftBaseline,
    createdAt: typeof value.createdAt === 'string' && value.createdAt ? value.createdAt : fallbackTimestamp,
    updatedAt: fallbackTimestamp,
  };
}

async function withSessionLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
  assertValidSessionId(sessionId);
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  sessionLocks.set(sessionId, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
  }
}

async function readEditingSessionUnlocked(sessionId: string): Promise<EditingSessionState> {
  try {
    const raw = await readFile(sessionPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as EditingSessionState & { workingDraftRevisions?: unknown };
    const normalized = normalizeEditingSessionState(parsed);
    if (Object.prototype.hasOwnProperty.call(parsed, 'workingDraftRevisions')) {
      // One-time destructive migration: legacy session files contained unbounded full prose
      // copies. Remove them immediately on first read, even if the session is never mutated again.
      return writeEditingSessionUnlocked(normalized);
    }
    return normalized;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new EditingSessionNotFoundError(sessionId);
    throw err;
  }
}

async function writeEditingSessionUnlocked(state: EditingSessionState): Promise<EditingSessionState> {
  await mkdir(stateDir(), { recursive: true });
  const next = normalizeEditingSessionState({ ...state, updatedAt: new Date().toISOString() });
  const targetPath = sessionPath(state.sessionId);
  const temporaryPath = path.join(
    stateDir(),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporaryPath, targetPath);
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return next;
}

export async function readEditingSession(sessionId: string): Promise<EditingSessionState> {
  return withSessionLock(sessionId, () => readEditingSessionUnlocked(sessionId));
}

/**
 * Compatibility full-state write. New read-modify-write callers should use
 * `updateEditingSession`, which reads the latest state while holding the same lock.
 */
export async function writeEditingSession(state: EditingSessionState): Promise<EditingSessionState> {
  return withSessionLock(state.sessionId, () => writeEditingSessionUnlocked(state));
}

export async function updateEditingSession(
  sessionId: string,
  updater: (state: EditingSessionState) => EditingSessionState | Promise<EditingSessionState>,
): Promise<EditingSessionState> {
  return withSessionLock(sessionId, async () => {
    const current = await readEditingSessionUnlocked(sessionId);
    const updated = await updater(current);
    if (updated.sessionId !== sessionId) {
      throw new Error(`editing_session_id_mismatch: expected ${sessionId}, received ${updated.sessionId}`);
    }
    return writeEditingSessionUnlocked(updated);
  });
}

/**
 * Serializes the entire external finalization sequence with every session mutation. The callback
 * receives the state read under the lock; returning `finalized:false` keeps the session intact,
 * while `finalized:true` removes it before releasing the lock. A queued mutation therefore either
 * happens before finalization or observes `editing_session_not_found` afterwards.
 */
export async function finalizeEditingSession<Outcome extends EditingSessionFinalizationOutcome<unknown>>(
  sessionId: string,
  finalize: (state: EditingSessionState) => Promise<Outcome>,
): Promise<Outcome['value']> {
  return withSessionLock(sessionId, async () => {
    const state = await readEditingSessionUnlocked(sessionId);
    const outcome = await finalize(state);
    if (outcome.finalized) await rm(sessionPath(sessionId), { force: true });
    return outcome.value as Outcome['value'];
  });
}

export async function deleteEditingSession(sessionId: string): Promise<void> {
  await withSessionLock(sessionId, () => rm(sessionPath(sessionId), { force: true }));
}

/**
 * Creates a new session file, or returns the existing one unchanged if `sessionId` already
 * has a file on disk — resuming a session must never reset findings/decisions/rewrites already
 * recorded, same idempotent-resume behaviour the old graph-node version had.
 */
export async function createOrResumeEditingSession(input: {
  sessionId: string;
  chapterNumber?: number;
  role?: ChapterSectionRole;
  title?: string;
  manuscriptId?: string;
  draftId?: string;
  notes?: string;
  baselineContent?: string;
}): Promise<EditingSessionState> {
  return withSessionLock(input.sessionId, async () => {
    try {
      return await readEditingSessionUnlocked(input.sessionId);
    } catch (err) {
      if (!(err instanceof EditingSessionNotFoundError)) throw err;
    }
    const now = new Date().toISOString();
    const state: EditingSessionState = {
      sessionId: input.sessionId,
      chapterNumber: input.chapterNumber,
      role: input.role,
      title: input.title,
      manuscriptId: input.manuscriptId,
      draftId: input.draftId,
      notes: input.notes,
      status: 'active',
      blocks: [],
      findings: [],
      decisions: [],
      rewrites: [],
      seamReview: null,
      visualBriefs: [],
      assembledRevision: null,
      workingDraftBaseline: input.baselineContent === undefined ? null : snapshotFields(input.baselineContent, now),
      createdAt: now,
      updatedAt: now,
    };
    return writeEditingSessionUnlocked(state);
  });
}
