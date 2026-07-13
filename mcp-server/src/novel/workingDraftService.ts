import * as kg from '../graph/neo4jStore.js';
import { normalizeChapterLabel } from './domain.js';
import {
  readEditingSession,
  updateEditingSession,
  type EditingSessionState,
  type WorkingDraftBaseline,
} from './editingSessionStore.js';
import {
  checkWorkingDraftLength,
  type WorkingDraftAuthor,
  type WorkingDraftLengthGate,
  type WorkingDraftSnapshot,
} from './workingDraft.js';

export interface SessionWorkingDraft extends WorkingDraftSnapshot {
  sessionId: string;
}

export interface WorkingDraftServiceResult {
  draft: SessionWorkingDraft;
  changed: boolean;
  historyCount: number;
  lengthGate: WorkingDraftLengthGate & { ok: boolean; message: string };
}

export class DraftVersionConflictError extends Error {
  readonly code = 'DRAFT_VERSION_CONFLICT';
  readonly current: SessionWorkingDraft;
  readonly expectedContentHash: string;
  readonly expectedRevision: number;

  constructor(input: {
    sessionId: string;
    current: WorkingDraftSnapshot;
    expectedContentHash: string;
    expectedRevision: number;
  }) {
    super('La bozza remota è cambiata dopo il caricamento.');
    this.name = 'DraftVersionConflictError';
    this.current = { ...input.current, sessionId: input.sessionId };
    this.expectedContentHash = input.expectedContentHash;
    this.expectedRevision = input.expectedRevision;
  }
}

export class WorkingDraftNotFoundError extends Error {
  readonly code = 'WORKING_DRAFT_NOT_FOUND';

  constructor(chapterNumber: number) {
    super(`Nessuna bozza di lavoro trovata per il Capitolo ${chapterNumber}.`);
    this.name = 'WorkingDraftNotFoundError';
  }
}

export class ChapterFinalizationInProgressError extends Error {
  readonly code = 'CHAPTER_FINALIZATION_IN_PROGRESS';
  readonly chapterNumber: number;
  readonly finalizingSessionId?: string;

  constructor(chapterNumber: number, finalizingSessionId?: string) {
    super(`La finalizzazione del Capitolo ${chapterNumber} deve essere completata prima di modificare la bozza.`);
    this.name = 'ChapterFinalizationInProgressError';
    this.chapterNumber = chapterNumber;
    this.finalizingSessionId = finalizingSessionId;
  }
}

const chapterLocks = new Map<number, Promise<void>>();

export async function withWorkingDraftChapterLock<T>(chapterNumber: number, action: () => Promise<T>): Promise<T> {
  const previous = chapterLocks.get(chapterNumber) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  chapterLocks.set(chapterNumber, tail);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (chapterLocks.get(chapterNumber) === tail) chapterLocks.delete(chapterNumber);
  }
}

function validateSessionTarget(state: EditingSessionState, chapterNumber: number): void {
  if (state.status !== 'active') throw new Error(`editing_session_closed: ${state.sessionId}`);
  if (state.chapterNumber !== chapterNumber || state.role) {
    throw new Error(`editing_session_chapter_mismatch: session=${state.chapterNumber ?? state.role}, requested=${chapterNumber}`);
  }
}

function baselineFrom(draft: WorkingDraftSnapshot): WorkingDraftBaseline {
  return {
    contentHash: draft.contentHash,
    wordCount: draft.wordCount,
    charCount: draft.charCount,
    draftNodeId: draft.draftNodeId,
    createdAt: draft.updatedAt || new Date().toISOString(),
  };
}

function validateDraftBaseline(state: EditingSessionState, draft: WorkingDraftSnapshot): void {
  if (!state.workingDraftBaseline) return;
  if (state.workingDraftBaseline.draftNodeId) {
    if (state.workingDraftBaseline.draftNodeId !== draft.draftNodeId) {
      throw new Error(`editing_session_stale_draft: chapter ${draft.chapterNumber}`);
    }
    return;
  }
  if (
    draft.revision !== 1
    || draft.retainedVersionCount !== 1
    || draft.contentHash !== state.workingDraftBaseline.contentHash
  ) {
    throw new Error(`editing_session_stale_legacy_baseline: chapter ${draft.chapterNumber}`);
  }
}

async function ensureDraftBaseline(sessionId: string, chapterNumber: number, draft: WorkingDraftSnapshot): Promise<EditingSessionState> {
  return updateEditingSession(sessionId, (state) => {
    validateSessionTarget(state, chapterNumber);
    validateDraftBaseline(state, draft);
    if (state.workingDraftBaseline?.draftNodeId) return state;
    if (state.workingDraftBaseline) {
      return {
        ...state,
        workingDraftBaseline: { ...state.workingDraftBaseline, draftNodeId: draft.draftNodeId },
      };
    }
    if (draft.revision !== 1 || draft.retainedVersionCount !== 1) {
      throw new Error(`working_draft_baseline_missing: cannot infer original text from revision ${draft.revision}`);
    }
    return { ...state, workingDraftBaseline: baselineFrom(draft) };
  });
}

function response(sessionId: string, draft: WorkingDraftSnapshot, state: EditingSessionState, changed: boolean): WorkingDraftServiceResult {
  const baselineWords = state.workingDraftBaseline?.wordCount ?? draft.wordCount;
  const gate = checkWorkingDraftLength(baselineWords, draft.content);
  return {
    draft: { ...draft, sessionId },
    changed,
    historyCount: draft.retainedVersionCount,
    lengthGate: {
      ...gate,
      ok: gate.valid,
      message: gate.valid
        ? `Gate rispettato: ${gate.currentWords} parole (${gate.minWords}–${gate.maxWords}).`
        : `Gate non rispettato: ${gate.currentWords} parole, intervallo consentito ${gate.minWords}–${gate.maxWords}.`,
    },
  };
}

export async function getSessionWorkingDraft(sessionId: string, chapterNumber: number): Promise<WorkingDraftServiceResult> {
  const session = await readEditingSession(sessionId);
  validateSessionTarget(session, chapterNumber);
  const draft = await kg.getWorkingDraft(chapterNumber);
  if (!draft) throw new WorkingDraftNotFoundError(chapterNumber);
  validateDraftBaseline(session, draft);
  return response(sessionId, draft, session, false);
}

export async function updateSessionWorkingDraft(input: {
  sessionId: string;
  chapterNumber: number;
  content: string;
  expectedContentHash: string;
  expectedRevision: number;
  author: WorkingDraftAuthor;
  clientMutationId?: string;
  changeSummary?: string;
}): Promise<WorkingDraftServiceResult> {
  return withWorkingDraftChapterLock(input.chapterNumber, async () => {
    const expectedContentHash = input.expectedContentHash.toLowerCase();
    const chapter = await kg.getNodeByTypeLabel('chapter', normalizeChapterLabel(input.chapterNumber));
    if (chapter?.metadata.canonStatus === 'finalizing') {
      throw new ChapterFinalizationInProgressError(
        input.chapterNumber,
        typeof chapter.metadata.lastFinalizedSessionId === 'string' ? chapter.metadata.lastFinalizedSessionId : undefined,
      );
    }
    const session = await readEditingSession(input.sessionId);
    validateSessionTarget(session, input.chapterNumber);
    const currentBefore = await kg.getWorkingDraft(input.chapterNumber);
    if (!currentBefore) throw new WorkingDraftNotFoundError(input.chapterNumber);
    const baselineState = await ensureDraftBaseline(input.sessionId, input.chapterNumber, currentBefore);
    const result = await kg.compareAndSwapWorkingDraft({
      chapterNumber: input.chapterNumber,
      content: input.content,
      expectedContentHash,
      expectedRevision: input.expectedRevision,
      author: input.author,
      clientMutationId: input.clientMutationId,
      changeSummary: input.changeSummary,
    });
    if (result.status === 'conflict') {
      throw new DraftVersionConflictError({
        sessionId: input.sessionId,
        current: result.current,
        expectedContentHash,
        expectedRevision: input.expectedRevision,
      });
    }
    return response(input.sessionId, result.draft, baselineState, result.status === 'updated');
  });
}
