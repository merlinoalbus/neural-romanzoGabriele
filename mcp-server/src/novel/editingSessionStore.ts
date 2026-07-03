import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ChapterSectionRole, EditorialDecisionStatus, EditorialFindingCategory } from './domain.js';
import type { ChapterBlock, RewriteLengthCheck } from './editingWorkflow.js';

/**
 * Editorial work-in-progress (session, blocks, findings, decisions, rewrites, seam review,
 * visual briefs) is never a graph node: the neural model must contain only final canonical
 * content. This store persists that working state as one JSON file per session, outside Neo4j,
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
  createdAt: string;
  updatedAt: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function readEditingSession(sessionId: string): Promise<EditingSessionState> {
  try {
    const raw = await readFile(sessionPath(sessionId), 'utf8');
    return JSON.parse(raw) as EditingSessionState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new EditingSessionNotFoundError(sessionId);
    throw err;
  }
}

export async function writeEditingSession(state: EditingSessionState): Promise<EditingSessionState> {
  await mkdir(stateDir(), { recursive: true });
  const next: EditingSessionState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(sessionPath(state.sessionId), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export async function deleteEditingSession(sessionId: string): Promise<void> {
  await rm(sessionPath(sessionId), { force: true });
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
}): Promise<EditingSessionState> {
  if (await fileExists(sessionPath(input.sessionId))) {
    return readEditingSession(input.sessionId);
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
    createdAt: now,
    updatedAt: now,
  };
  return writeEditingSession(state);
}
