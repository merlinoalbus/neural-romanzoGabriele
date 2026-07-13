import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { embedNodesInline } from '../services/embeddingSync.js';
import {
  CHAPTER_SECTION_ROLES,
  EDITORIAL_DECISION_STATUSES,
  EDITORIAL_FINDING_CATEGORIES,
  NOVEL_DRAFT_STATUSES,
  resolveChapterSectionLabel,
  type ChapterSectionRole,
} from '../novel/domain.js';
import {
  createOrResumeEditingSession,
  EditingSessionNotFoundError,
  finalizeEditingSession,
  readEditingSession,
  updateEditingSession,
  type EditingSessionState,
} from '../novel/editingSessionStore.js';
import {
  assembleRevisedBlocks,
  checkRewriteLength,
  makeFindingId,
  normalizeEditingStep,
  splitChapterIntoBlocks,
  stableHash,
} from '../novel/editingWorkflow.js';
import {
  ChapterFinalizationInProgressError,
  DraftVersionConflictError,
  getSessionWorkingDraft,
  updateSessionWorkingDraft,
  withWorkingDraftChapterLock,
} from '../novel/workingDraftService.js';
import {
  checkWorkingDraftLength,
  isWorkingDraftAuditCurrent,
  normalizeWorkingDraftContent,
  workingDraftContentHash,
  workingDraftWordCount,
} from '../novel/workingDraft.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

const jsonObj = z.record(z.string(), z.unknown());
const findingCategoryZ = z.enum(EDITORIAL_FINDING_CATEGORIES);
const decisionStatusZ = z.enum(EDITORIAL_DECISION_STATUSES);
const draftStatusZ = z.enum(NOVEL_DRAFT_STATUSES);

const nodeZ = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  content: z.string(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
  updatedAt: z.string(),
});

const chapterBlockZ = z.object({
  blockNumber: z.number(),
  label: z.string(),
  text: z.string(),
  wordCount: z.number(),
  charCount: z.number(),
  startPhrase: z.string(),
  endPhrase: z.string(),
});

const rewriteLengthCheckZ = z.object({
  originalChars: z.number(),
  revisedChars: z.number(),
  ratio: z.number(),
  minAllowed: z.number(),
  maxAllowed: z.number(),
  valid: z.boolean(),
});

const chapterSectionRoleZ = z.enum(CHAPTER_SECTION_ROLES);

const chapterIdentifierShape = {
  chapterNumber: z.number().int().positive().optional(),
  role: chapterSectionRoleZ.optional(),
};

const sessionSummaryZ = z.object({
  sessionId: z.string(),
  chapterNumber: z.number().optional(),
  role: chapterSectionRoleZ.optional(),
  title: z.string().optional(),
  manuscriptId: z.string().optional(),
  draftId: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['active', 'closed']),
  blockCount: z.number(),
  findingCount: z.number(),
  decisionCount: z.number(),
  rewriteCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const editorialFindingRecordZ = z.object({
  id: z.string(),
  step: z.string(),
  blockNumber: z.number().optional(),
  category: findingCategoryZ,
  severity: z.enum(['info', 'warning', 'error']),
  originalText: z.string().optional(),
  problem: z.string(),
  suggestion: z.string().optional(),
  notes: z.string().optional(),
  metadata: jsonObj.optional(),
  createdAt: z.string(),
});

const editorialDecisionRecordZ = z.object({
  findingId: z.string(),
  status: decisionStatusZ,
  reason: z.string().optional(),
  instructions: z.string().optional(),
  metadata: jsonObj.optional(),
  updatedAt: z.string(),
});

const rewriteBlockRecordZ = z.object({
  blockNumber: z.number(),
  revisedText: z.string(),
  originalHash: z.string(),
  revisedHash: z.string(),
  lengthCheck: rewriteLengthCheckZ,
  appliedFindingIds: z.array(z.string()),
  approved: z.boolean(),
  updatedAt: z.string(),
});

const seamReviewRecordZ = z.object({
  summary: z.string(),
  findings: z.array(z.string()),
  approved: z.boolean(),
  updatedAt: z.string(),
});

const visualBriefRecordZ = z.object({
  sceneSummary: z.string(),
  characters: z.array(z.string()),
  promptIt: z.string(),
  promptEn: z.string().optional(),
  styleModifier: z.string().optional(),
  sourceText: z.string().optional(),
  metadata: jsonObj.optional(),
  createdAt: z.string(),
});

const workingDraftZ = z.object({
  chapterNumber: z.number(),
  sessionId: z.string(),
  title: z.string(),
  content: z.string(),
  contentHash: z.string(),
  revision: z.number(),
  wordCount: z.number(),
  charCount: z.number(),
  updatedAt: z.string(),
  updatedBy: z.enum(['ingest', 'user', 'llm', 'system']),
  draftNodeId: z.string(),
  documentId: z.string(),
  sourceId: z.string(),
  retainedVersionCount: z.number(),
  auditStatus: z.enum(['pending', 'passed', 'failed']),
  auditContentHash: z.string().optional(),
  auditRevision: z.number().optional(),
  auditAt: z.string().optional(),
  auditError: z.string().optional(),
});

const workingDraftLengthGateZ = z.object({
  baselineWords: z.number(),
  currentWords: z.number(),
  ratio: z.number(),
  minWords: z.number(),
  maxWords: z.number(),
  valid: z.boolean(),
  ok: z.boolean(),
  message: z.string(),
});

const workingDraftCleanupZ = z.object({
  draftNodes: z.number(),
  documents: z.number(),
  chunks: z.number(),
  findings: z.number(),
  assets: z.number(),
});

const editorialFindingInputZ = z.object({
  id: z.string().optional(),
  step: z.string(),
  blockNumber: z.number().int().positive().optional(),
  category: findingCategoryZ,
  severity: z.enum(['info', 'warning', 'error']),
  originalText: z.string().optional(),
  problem: z.string(),
  suggestion: z.string().optional(),
  notes: z.string().optional(),
  metadata: jsonObj.optional(),
});

const editorialDecisionInputZ = z.object({
  findingId: z.string(),
  status: decisionStatusZ,
  reason: z.string().optional(),
  instructions: z.string().optional(),
  metadata: jsonObj.optional(),
});

function sessionSummary(state: EditingSessionState): z.infer<typeof sessionSummaryZ> {
  return {
    sessionId: state.sessionId,
    chapterNumber: state.chapterNumber,
    role: state.role,
    title: state.title,
    manuscriptId: state.manuscriptId,
    draftId: state.draftId,
    notes: state.notes,
    status: state.status,
    blockCount: state.blocks.length,
    findingCount: state.findings.length,
    decisionCount: state.decisions.length,
    rewriteCount: state.rewrites.length,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function newSessionId(input: { chapterNumber?: number; role?: ChapterSectionRole; title?: string; manuscriptId?: string; draftId?: string }): string {
  const slug = input.role ?? String(input.chapterNumber).padStart(3, '0');
  return `editing-${slug}-${stableHash(JSON.stringify(input), 12)}`;
}

function blockingErrorFindings(state: EditingSessionState): Array<{ findingId: string; decisionStatus: string }> {
  const decisions = new Map(state.decisions.map((decision) => [decision.findingId, decision.status]));
  return state.findings
    .filter((finding) => finding.severity === 'error')
    .map((finding) => ({ findingId: finding.id, decisionStatus: decisions.get(finding.id) ?? 'missing' }))
    .filter(({ decisionStatus }) => decisionStatus !== 'approved' && decisionStatus !== 'applied');
}

function preservedChapterTitle(input: {
  requestedTitle?: string;
  existingChapter: kg.GraphNode | null;
  sessionTitle?: string;
  fallback: string;
}): string {
  const existingTitle = input.existingChapter?.metadata.title;
  return input.requestedTitle?.trim()
    || (typeof existingTitle === 'string' ? existingTitle.trim() : '')
    || input.sessionTitle?.trim()
    || input.fallback;
}

function isMatchingFinalizationRetry(input: {
  existingChapter: kg.GraphNode | null;
  sessionId: string;
  finalHash: string;
  normalizedContent: string;
}): boolean {
  return Boolean(
    input.existingChapter &&
    input.existingChapter.metadata.canonStatus === 'canonical' &&
    input.existingChapter.metadata.finalHash === input.finalHash &&
    input.existingChapter.metadata.lastFinalizedSessionId === input.sessionId &&
    normalizeWorkingDraftContent(input.existingChapter.content) === input.normalizedContent
  );
}

function isMatchingFinalizationInProgress(input: {
  existingChapter: kg.GraphNode | null;
  sessionId: string;
  finalHash: string;
  normalizedContent: string;
}): boolean {
  return Boolean(
    input.existingChapter
    && input.existingChapter.metadata.canonStatus === 'finalizing'
    && input.existingChapter.metadata.editorialFinalizationStatus === 'cleanup_pending'
    && input.existingChapter.metadata.finalHash === input.finalHash
    && input.existingChapter.metadata.lastFinalizedSessionId === input.sessionId
    && normalizeWorkingDraftContent(input.existingChapter.content) === input.normalizedContent
  );
}

export function rethrowChapterIdentityAmbiguity(error: unknown): void {
  if (error instanceof kg.ChapterIdentityAmbiguousError) throw error;
}

async function ensureChapter(identifier: { chapterNumber?: number; role?: ChapterSectionRole }, title?: string): Promise<kg.GraphNode> {
  const chapterLabel = resolveChapterSectionLabel(identifier);
  const existing = identifier.chapterNumber === undefined
    ? await kg.getNodeByTypeLabel('chapter', chapterLabel)
    : await kg.getChapterByNumber(identifier.chapterNumber);
  // Opening an editorial session must never demote or overwrite an already canonical chapter.
  // The chapter node is an immutable anchor until novel_save_final_chapter performs the explicit
  // canonization update at the end of the workflow.
  if (existing) return existing;
  const written = await kg.upsertNode({
    type: 'chapter',
    label: chapterLabel,
    content: title ?? chapterLabel,
    metadata: { chapterNumber: identifier.chapterNumber, role: identifier.role, title: title ?? chapterLabel, canonStatus: 'draft' },
    provenance: { source: 'novel_editing_workflow', chapterNumber: identifier.chapterNumber, role: identifier.role },
  });
  return written.node;
}

export function registerNovelEditingTools(server: McpServer): void {
  server.registerTool(
    'novel_get_working_draft',
    {
      title: 'Novel get working draft',
      description: 'Reads the current full chapter draft, its SHA-256 CAS token and monotonic revision. It never reads or creates historical draft nodes.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
      },
      outputSchema: {
        ok: z.boolean(),
        draft: workingDraftZ.optional(),
        changed: z.boolean().optional(),
        historyCount: z.number().optional(),
        lengthGate: workingDraftLengthGateZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel get working draft', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber }) => {
      try {
        return toolStructured({ ok: true, ...(await getSessionWorkingDraft(sessionId, chapterNumber)) });
      } catch (err) {
        return toolError('NOVEL_GET_WORKING_DRAFT_FAILED', `novel_get_working_draft failed: ${String(err)}`, { sessionId, chapterNumber });
      }
    },
  );

  server.registerTool(
    'novel_update_working_draft',
    {
      title: 'Novel update working draft',
      description:
        'Updates the single current chapter_draft node with optimistic concurrency. Both the full SHA-256 hash and monotonic revision must match. There is deliberately no force option for the LLM.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
        content: z.string(),
        expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/i),
        expectedRevision: z.number().int().positive(),
        clientMutationId: z.string().max(200).optional(),
        changeSummary: z.string().max(2000).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        draft: workingDraftZ.optional(),
        changed: z.boolean().optional(),
        historyCount: z.number().optional(),
        lengthGate: workingDraftLengthGateZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel update working draft', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, content, expectedContentHash, expectedRevision, clientMutationId, changeSummary }) => {
      try {
        return toolStructured({
          ok: true,
          ...(await updateSessionWorkingDraft({
            sessionId,
            chapterNumber,
            content,
            expectedContentHash,
            expectedRevision,
            author: 'llm',
            clientMutationId,
            changeSummary,
          })),
        });
      } catch (err) {
        if (err instanceof DraftVersionConflictError) {
          return toolError(err.code, err.message, {
            current: err.current,
            expectedContentHash: err.expectedContentHash,
            expectedRevision: err.expectedRevision,
          });
        }
        if (err instanceof ChapterFinalizationInProgressError) {
          return toolError(err.code, err.message, {
            chapterNumber: err.chapterNumber,
            finalizingSessionId: err.finalizingSessionId,
          });
        }
        return toolError('NOVEL_UPDATE_WORKING_DRAFT_FAILED', `novel_update_working_draft failed: ${String(err)}`, { sessionId, chapterNumber });
      }
    },
  );

  server.registerTool(
    'novel_start_editing_session',
    {
      title: 'Novel start editing session',
      description:
        'Creates or resumes an editorial workflow session for a chapter, Prologo or Epilogo. Findings, decisions, revisions and briefs live in a bounded session file; Neo4j keeps at most one current non-canonical chapter_draft.',
      inputSchema: {
        ...chapterIdentifierShape,
        title: z.string().optional(),
        sessionId: z.string().optional(),
        manuscriptId: z.string().optional(),
        draftId: z.string().optional(),
        notes: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), sessionId: z.string().optional(), session: sessionSummaryZ.optional(), chapter: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel start editing session', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, role, title, sessionId, manuscriptId, draftId, notes }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_START_EDITING_SESSION_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        const id = sessionId?.trim() || newSessionId({ chapterNumber, role, title, manuscriptId, draftId });
        const chapter = await ensureChapter({ chapterNumber, role }, title);
        const state = await createOrResumeEditingSession({ sessionId: id, chapterNumber, role, title, manuscriptId, draftId, notes });
        return toolStructured({ ok: true, sessionId: id, session: sessionSummary(state), chapter });
      } catch (err) {
        return toolError('NOVEL_START_EDITING_SESSION_FAILED', `novel_start_editing_session failed: ${String(err)}`, { chapterNumber, role, sessionId });
      }
    },
  );

  server.registerTool(
    'novel_split_chapter_blocks',
    {
      title: 'Novel split chapter blocks',
      description: 'Splits a chapter into bounded editorial blocks and optionally persists them into the session file (not the graph). Blocks are LARGE by default (2500 words, up to 20000): focus is guaranteed by the graph canon, not by block size — a whole chapter can be a single block. The chapter/Prologo/Epilogo identity is already carried by sessionId.',
      inputSchema: {
        sessionId: z.string(),
        content: z.string(),
        maxWords: z.number().int().positive().optional(),
        persist: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), blocks: z.array(chapterBlockZ).optional(), error: errorObj },
      annotations: { title: 'Novel split chapter blocks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, content, maxWords, persist }) => {
      try {
        const blocks = splitChapterIntoBlocks(content, maxWords ?? 2500);
        if (!persist) return toolStructured({ ok: true, blocks });
        const baselineContent = normalizeWorkingDraftContent(content);
        const persistBlocks = () => updateEditingSession(sessionId, async (state) => {
          if (state.status !== 'active') throw new Error(`editing_session_closed: ${sessionId}`);
          if (state.chapterNumber !== undefined) {
            const currentDraft = await kg.getWorkingDraft(state.chapterNumber);
            if (!currentDraft) throw new Error(`working_draft_not_found: chapter ${state.chapterNumber}`);
            const splitHash = workingDraftContentHash(baselineContent);
            if (currentDraft.contentHash !== splitHash || currentDraft.content !== baselineContent) {
              throw new Error(`working_draft_split_conflict: chapter ${state.chapterNumber} content must match revision ${currentDraft.revision}`);
            }
            if (state.workingDraftBaseline?.draftNodeId) {
              if (state.workingDraftBaseline.draftNodeId !== currentDraft.draftNodeId) {
                throw new Error(`editing_session_stale_draft: chapter ${state.chapterNumber}`);
              }
              return { ...state, blocks };
            }
            if (state.workingDraftBaseline) {
              if (
                currentDraft.revision !== 1 ||
                currentDraft.retainedVersionCount !== 1 ||
                currentDraft.contentHash !== state.workingDraftBaseline.contentHash
              ) {
                throw new Error(`editing_session_stale_legacy_baseline: chapter ${state.chapterNumber}`);
              }
              return {
                ...state,
                blocks,
                workingDraftBaseline: { ...state.workingDraftBaseline, draftNodeId: currentDraft.draftNodeId },
              };
            }
            if (
              currentDraft.revision !== 1 ||
              currentDraft.retainedVersionCount !== 1 ||
              currentDraft.contentHash !== splitHash
            ) {
              throw new Error(`working_draft_baseline_mismatch: chapter ${state.chapterNumber} must be seeded from revision 1`);
            }
            return {
              ...state,
              blocks,
              workingDraftBaseline: {
                contentHash: currentDraft.contentHash,
                wordCount: currentDraft.wordCount,
                charCount: currentDraft.charCount,
                draftNodeId: currentDraft.draftNodeId,
                createdAt: currentDraft.updatedAt || new Date().toISOString(),
              },
            };
          }

          // Prologo/Epilogo do not currently have a numbered working-draft projection.
          if (state.workingDraftBaseline) return { ...state, blocks };
          return {
            ...state,
            blocks,
            workingDraftBaseline: {
              contentHash: workingDraftContentHash(baselineContent),
              wordCount: workingDraftWordCount(baselineContent),
              charCount: baselineContent.length,
              createdAt: new Date().toISOString(),
            },
          };
        });
        const targetSession = await readEditingSession(sessionId);
        if (targetSession.chapterNumber === undefined) await persistBlocks();
        else await withWorkingDraftChapterLock(targetSession.chapterNumber, persistBlocks);
        return toolStructured({ ok: true, blocks });
      } catch (err) {
        return toolError('NOVEL_SPLIT_CHAPTER_BLOCKS_FAILED', `novel_split_chapter_blocks failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_editorial_findings',
    {
      title: 'Novel save editorial findings',
      description: 'Stores Step 1/2/4/5/6 editorial findings in the session file. Non-canonical working state, never written to the graph.',
      inputSchema: {
        sessionId: z.string(),
        findings: z.array(editorialFindingInputZ).min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), findings: z.array(editorialFindingRecordZ).optional(), summary: z.record(z.string(), z.number()).optional(), error: errorObj },
      annotations: { title: 'Novel save editorial findings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, findings }) => {
      try {
        const now = new Date().toISOString();
        const summary: Record<string, number> = { total: findings.length };
        let nextFindings: EditingSessionState['findings'] = [];
        await updateEditingSession(sessionId, (state) => {
          const byId = new Map(state.findings.map((finding) => [finding.id, finding]));
          for (let index = 0; index < findings.length; index++) {
            const finding = findings[index];
            const { step: rawStep, ...findingWithoutStep } = finding;
            const step = normalizeEditingStep(rawStep);
            const findingId = finding.id?.trim() || makeFindingId({ sessionId, step, blockNumber: finding.blockNumber, index: index + 1 });
            summary[`severity:${finding.severity}`] = (summary[`severity:${finding.severity}`] ?? 0) + 1;
            summary[`category:${finding.category}`] = (summary[`category:${finding.category}`] ?? 0) + 1;
            byId.set(findingId, { ...findingWithoutStep, step, id: findingId, createdAt: byId.get(findingId)?.createdAt ?? now });
          }
          nextFindings = [...byId.values()];
          return { ...state, findings: nextFindings };
        });
        return toolStructured({ ok: true, findings: nextFindings, summary });
      } catch (err) {
        return toolError('NOVEL_SAVE_EDITORIAL_FINDINGS_FAILED', `novel_save_editorial_findings failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_user_decisions',
    {
      title: 'Novel save user decisions',
      description: 'Stores user approvals/rejections/deferred decisions for editorial findings in the session file.',
      inputSchema: {
        sessionId: z.string(),
        decisions: z.array(editorialDecisionInputZ).min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), decisions: z.array(editorialDecisionRecordZ).optional(), error: errorObj },
      annotations: { title: 'Novel save user decisions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, decisions }) => {
      try {
        const now = new Date().toISOString();
        let nextDecisions: EditingSessionState['decisions'] = [];
        await updateEditingSession(sessionId, (state) => {
          const byFindingId = new Map(state.decisions.map((decision) => [decision.findingId, decision]));
          for (const decision of decisions) byFindingId.set(decision.findingId, { ...decision, updatedAt: now });
          nextDecisions = [...byFindingId.values()];
          return { ...state, decisions: nextDecisions };
        });
        return toolStructured({ ok: true, decisions: nextDecisions });
      } catch (err) {
        return toolError('NOVEL_SAVE_USER_DECISIONS_FAILED', `novel_save_user_decisions failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_rewrite_block',
    {
      title: 'Novel save rewrite block',
      description: 'Stores a rewritten block in the session file, only if its length stays within the mandated 85%-140% range.',
      inputSchema: {
        sessionId: z.string(),
        blockNumber: z.number().int().positive(),
        originalText: z.string(),
        revisedText: z.string(),
        appliedFindingIds: z.array(z.string()).optional(),
        approved: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), rewrite: rewriteBlockRecordZ.optional(), lengthCheck: rewriteLengthCheckZ.optional(), error: errorObj },
      annotations: { title: 'Novel save rewrite block', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, blockNumber, originalText, revisedText, appliedFindingIds, approved }) => {
      try {
        const lengthCheck = checkRewriteLength(originalText, revisedText);
        if (!lengthCheck.valid) return toolError('NOVEL_REWRITE_LENGTH_INVALID', 'Rewrite block is outside the allowed 85%-140% length range.', { lengthCheck, sessionId, blockNumber });
        const record = {
          blockNumber,
          revisedText,
          originalHash: stableHash(originalText),
          revisedHash: stableHash(revisedText),
          lengthCheck,
          appliedFindingIds: appliedFindingIds ?? [],
          approved: Boolean(approved),
          updatedAt: new Date().toISOString(),
        };
        await updateEditingSession(sessionId, (state) => ({
          ...state,
          rewrites: [...state.rewrites.filter((rewrite) => rewrite.blockNumber !== blockNumber), record],
        }));
        return toolStructured({ ok: true, rewrite: record, lengthCheck });
      } catch (err) {
        return toolError('NOVEL_SAVE_REWRITE_BLOCK_FAILED', `novel_save_rewrite_block failed: ${String(err)}`, { sessionId, blockNumber });
      }
    },
  );

  server.registerTool(
    'novel_assemble_chapter_revision',
    {
      title: 'Novel assemble chapter revision',
      description: 'Assembles the session\'s saved rewrite blocks into a chapter revision. Returned as text only — never persisted as a separate draft node.',
      inputSchema: {
        sessionId: z.string(),
        expectedBlocks: z.number().int().positive().optional(),
      },
      outputSchema: { ok: z.boolean(), content: z.string().optional(), missingBlocks: z.array(z.number()).optional(), error: errorObj },
      annotations: { title: 'Novel assemble chapter revision', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, expectedBlocks }) => {
      try {
        let content = '';
        let expectedMissing: number[] = [];
        await updateEditingSession(sessionId, (state) => {
          const blocks = state.rewrites.map((rewrite) => ({ blockNumber: rewrite.blockNumber, text: rewrite.revisedText }));
          expectedMissing = expectedBlocks
            ? Array.from({ length: expectedBlocks }, (_value, index) => index + 1).filter((blockNumber) => !blocks.some((block) => block.blockNumber === blockNumber))
            : [];
          if (expectedMissing.length) return state;
          content = assembleRevisedBlocks(blocks);
          return { ...state, assembledRevision: { content, blockCount: blocks.length, assembledAt: new Date().toISOString() } };
        });
        if (expectedMissing.length) return toolStructured({ ok: false, missingBlocks: expectedMissing });
        return toolStructured({ ok: true, content, missingBlocks: [] });
      } catch (err) {
        return toolError('NOVEL_ASSEMBLE_CHAPTER_REVISION_FAILED', `novel_assemble_chapter_revision failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_seam_review',
    {
      title: 'Novel save seam review',
      description: 'Stores Step 4 seam/redundancy review for the unified chapter in the session file.',
      inputSchema: {
        sessionId: z.string(),
        summary: z.string(),
        findings: z.array(z.string()).optional(),
        approved: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), seamReview: seamReviewRecordZ.optional(), error: errorObj },
      annotations: { title: 'Novel save seam review', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, summary, findings, approved }) => {
      try {
        const record = { summary, findings: findings ?? [], approved: Boolean(approved), updatedAt: new Date().toISOString() };
        await updateEditingSession(sessionId, (state) => ({ ...state, seamReview: record }));
        return toolStructured({ ok: true, seamReview: record });
      } catch (err) {
        return toolError('NOVEL_SAVE_SEAM_REVIEW_FAILED', `novel_save_seam_review failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_final_chapter',
    {
      title: 'Novel save final chapter',
      description:
        'Canonizes the final reviewed chapter/Prologo/Epilogo text by updating the existing chapter node in place (never a new draft node), then deletes the session file. This is the only path that turns editorial work into canon.',
      inputSchema: {
        sessionId: z.string(),
        ...chapterIdentifierShape,
        title: z.string().optional(),
        content: z.string(),
        status: draftStatusZ.optional(),
      },
      outputSchema: { ok: z.boolean(), chapter: nodeZ.optional(), cleanup: workingDraftCleanupZ.optional(), error: errorObj },
      annotations: { title: 'Novel save final chapter', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, role, title, content, status }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_SAVE_FINAL_CHAPTER_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        const finalize = async () => finalizeEditingSession(sessionId, async (state) => {
          if (state.status !== 'active') {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_SESSION_CLOSED', 'The editing session is not active.', { sessionId }),
            };
          }
          if (state.chapterNumber !== chapterNumber || state.role !== role) {
            return {
              finalized: false,
              value: toolError('NOVEL_SAVE_FINAL_CHAPTER_SESSION_MISMATCH', 'The editing session belongs to a different chapter or role.', {
                sessionId,
                sessionChapterNumber: state.chapterNumber,
                sessionRole: state.role,
                chapterNumber,
                role,
              }),
            };
          }
          const normalizedContent = normalizeWorkingDraftContent(content);
          if (!state.workingDraftBaseline) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_BASELINE_MISSING', 'Finalization requires the immutable original-draft baseline.', {
                sessionId,
                chapterNumber,
              }),
            };
          }
          const unresolvedErrors = blockingErrorFindings(state);
          if (unresolvedErrors.length) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_ERROR_FINDINGS_OPEN', 'Resolve or approve every severity-error finding before canonization.', {
                sessionId,
                chapterNumber,
                findings: unresolvedErrors,
              }),
            };
          }
          const lengthGate = checkWorkingDraftLength(state.workingDraftBaseline.wordCount, normalizedContent);
          if (!lengthGate.valid) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_LENGTH_GATE_FAILED', 'The final chapter is outside the required 85%-140% length gate.', {
                sessionId,
                chapterNumber,
                lengthGate,
              }),
            };
          }
          const finalHash = workingDraftContentHash(normalizedContent);
          const chapterLabel = resolveChapterSectionLabel({ chapterNumber, role });
          const existingChapter = chapterNumber === undefined
            ? await kg.getNodeByTypeLabel('chapter', chapterLabel)
            : await kg.getChapterByNumber(chapterNumber);
          if (
            existingChapter?.metadata.canonStatus === 'finalizing'
            && existingChapter.metadata.lastFinalizedSessionId !== sessionId
          ) {
            return {
              finalized: false,
              value: toolError('CHAPTER_FINALIZATION_IN_PROGRESS', 'A different editorial session owns the pending chapter finalization.', {
                sessionId,
                chapterNumber,
                role,
                finalizingSessionId: existingChapter.metadata.lastFinalizedSessionId,
              }),
            };
          }
          const currentDraft = chapterNumber === undefined ? null : await kg.getWorkingDraft(chapterNumber);
          if (currentDraft && !isWorkingDraftAuditCurrent(currentDraft)) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_AUDIT_REQUIRED', 'Run the autonomous draft audit successfully on the exact current hash and revision before canonization.', {
                sessionId,
                chapterNumber,
                contentHash: currentDraft.contentHash,
                revision: currentDraft.revision,
                auditStatus: currentDraft.auditStatus,
                auditContentHash: currentDraft.auditContentHash,
                auditRevision: currentDraft.auditRevision,
                auditError: currentDraft.auditError,
              }),
            };
          }
          const blockingGraphFindings = chapterNumber === undefined || !currentDraft
            ? []
            : (await kg.listWorkingDraftFindings(chapterNumber)).filter((finding) => (
                finding.metadata.severity === 'error'
                && finding.metadata.contentHash === currentDraft.contentHash
                && Number(finding.metadata.revision) === currentDraft.revision
              ));
          if (blockingGraphFindings.length) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_GRAPH_ERRORS_OPEN', 'The autonomous draft audit still contains severity-error findings. Correct and re-ingest the draft before canonization.', {
                sessionId,
                chapterNumber,
                findings: blockingGraphFindings.map((finding) => ({ id: finding.id, label: finding.label, content: finding.content })),
              }),
            };
          }
          if (currentDraft && state.workingDraftBaseline.draftNodeId && state.workingDraftBaseline.draftNodeId !== currentDraft.draftNodeId) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_STALE_SESSION', 'The session belongs to an older working-draft generation.', {
                sessionId,
                chapterNumber,
                sessionDraftNodeId: state.workingDraftBaseline.draftNodeId,
                currentDraftNodeId: currentDraft.draftNodeId,
              }),
            };
          }
          if (
            currentDraft &&
            !state.workingDraftBaseline.draftNodeId &&
            (
              currentDraft.revision !== 1 ||
              currentDraft.retainedVersionCount !== 1 ||
              currentDraft.contentHash !== state.workingDraftBaseline.contentHash
            )
          ) {
            return {
              finalized: false,
              value: toolError('NOVEL_FINAL_STALE_LEGACY_SESSION', 'The legacy session baseline cannot be bound safely to the current draft.', {
                sessionId,
                chapterNumber,
                currentDraftNodeId: currentDraft.draftNodeId,
                currentRevision: currentDraft.revision,
              }),
            };
          }
          if (chapterNumber !== undefined && !currentDraft) {
            const completedRetry = isMatchingFinalizationRetry({ existingChapter, sessionId, finalHash, normalizedContent });
            const inProgressRetry = isMatchingFinalizationInProgress({ existingChapter, sessionId, finalHash, normalizedContent });
            if (!completedRetry && !inProgressRetry) {
              return {
                finalized: false,
                value: toolError('NOVEL_FINAL_WORKING_DRAFT_REQUIRED', 'A matching current working draft is required before canonization.', {
                  sessionId,
                  chapterNumber,
                  proposedContentHash: finalHash,
                }),
              };
            }
            if (completedRetry) {
              // The canonical write and cleanup succeeded, but embedding or session deletion may
              // have lost its response. Re-embed idempotently, then let the session finalizer
              // remove the still-present file without demoting the chapter again.
              await embedNodesInline([existingChapter!.id]);
              return {
                finalized: true,
                value: toolStructured({
                  ok: true,
                  chapter: existingChapter!,
                  cleanup: { draftNodes: 0, documents: 0, chunks: 0, findings: 0, assets: 0 },
                }),
              };
            }
          } else if (currentDraft && (currentDraft.contentHash !== finalHash || currentDraft.content !== normalizedContent)) {
            return {
              finalized: false,
              value: toolError('DRAFT_VERSION_CONFLICT', 'Update the working draft with the approved final text before canonizing it.', {
                sessionId,
                chapterNumber,
                current: currentDraft,
                proposedContentHash: finalHash,
              }),
            };
          }
          const finalizedAt = state.updatedAt;
          const finalizationMetadata = {
            chapterNumber,
            role,
            title: preservedChapterTitle({ requestedTitle: title, existingChapter, sessionTitle: state.title, fallback: chapterLabel }),
            editorialStatus: status ?? 'approved',
            finalHash,
            lastFinalizedSessionId: sessionId,
            revisionHistory: [{ sessionId, finalHash, editedAt: finalizedAt }],
          };
          const writeChapter = async (metadata: Record<string, unknown>): Promise<kg.GraphNode> => {
            const provenance = { source: 'novel_save_final_chapter', sessionId, chapterNumber, role };
            if (existingChapter) {
              const updated = await kg.updateNode(existingChapter.id, { content: normalizedContent, metadata, provenance });
              if (!updated) throw new Error(`chapter_not_found_after_resolution: ${existingChapter.id}`);
              return updated;
            }
            return (await kg.upsertNode({
              type: 'chapter',
              label: chapterLabel,
              content: normalizedContent,
              metadata,
              provenance,
            })).node;
          };
          await writeChapter({
            ...finalizationMetadata,
            canonStatus: 'finalizing',
            editorialFinalizationStatus: 'cleanup_pending',
          });
          const cleanup = chapterNumber === undefined
            ? { draftNodes: 0, documents: 0, chunks: 0, findings: 0, assets: 0 }
            : await kg.cleanupWorkingDraftArtifacts(chapterNumber);
          const written = await writeChapter({
            ...finalizationMetadata,
            canonStatus: 'canonical',
            editorialFinalizationStatus: 'completed',
          });
          await embedNodesInline([written.id]);
          return { finalized: true, value: toolStructured({ ok: true, chapter: written, cleanup }) };
        });
        return chapterNumber === undefined ? await finalize() : await withWorkingDraftChapterLock(chapterNumber, finalize);
      } catch (err) {
        // A lost HTTP/MCP response may arrive after the successful finalizer removed its session.
        // Recognize only the exact same canonical result; never use this path to overwrite canon
        // or to clean up a newer working-draft generation.
        if (err instanceof EditingSessionNotFoundError && (chapterNumber !== undefined || role)) {
          try {
            const normalizedContent = normalizeWorkingDraftContent(content);
            const finalHash = workingDraftContentHash(normalizedContent);
            const chapterLabel = resolveChapterSectionLabel({ chapterNumber, role });
            const existingChapter = chapterNumber === undefined
              ? await kg.getNodeByTypeLabel('chapter', chapterLabel)
              : await kg.getChapterByNumber(chapterNumber);
            if (isMatchingFinalizationRetry({ existingChapter, sessionId, finalHash, normalizedContent })) {
              return toolStructured({
                ok: true,
                chapter: existingChapter!,
                cleanup: { draftNodes: 0, documents: 0, chunks: 0, findings: 0, assets: 0 },
              });
            }
          } catch (retryError) {
            rethrowChapterIdentityAmbiguity(retryError);
            // Preserve the original session-not-found failure below if retry verification fails.
          }
        }
        return toolError('NOVEL_SAVE_FINAL_CHAPTER_FAILED', `novel_save_final_chapter failed: ${String(err)}`, { sessionId, chapterNumber, role });
      }
    },
  );

  server.registerTool(
    'novel_create_visual_brief',
    {
      title: 'Novel create visual brief',
      description: 'Stores Step 6 visual brief and image prompt in the session file. It does not generate the image.',
      inputSchema: {
        sessionId: z.string(),
        sceneSummary: z.string(),
        characters: z.array(z.string()).optional(),
        promptIt: z.string(),
        promptEn: z.string().optional(),
        styleModifier: z.string().optional(),
        sourceText: z.string().optional(),
        metadata: jsonObj.optional(),
      },
      outputSchema: { ok: z.boolean(), visualBrief: visualBriefRecordZ.optional(), error: errorObj },
      annotations: { title: 'Novel create visual brief', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, sceneSummary, characters, promptIt, promptEn, styleModifier, sourceText, metadata }) => {
      try {
        const record = {
          sceneSummary,
          characters: characters ?? [],
          promptIt,
          promptEn,
          styleModifier,
          sourceText,
          metadata,
          createdAt: new Date().toISOString(),
        };
        await updateEditingSession(sessionId, (state) => ({ ...state, visualBriefs: [...state.visualBriefs, record] }));
        return toolStructured({ ok: true, visualBrief: record });
      } catch (err) {
        return toolError('NOVEL_CREATE_VISUAL_BRIEF_FAILED', `novel_create_visual_brief failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_attach_generated_image',
    {
      title: 'Novel attach generated image',
      description: 'Registers an already generated image path and links it to visual brief or image prompt nodes.',
      inputSchema: {
        sessionId: z.string(),
        imagePath: z.string(),
        mime: z.string().optional(),
        label: z.string().optional(),
        visualBriefId: z.string().optional(),
        imagePromptId: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), error: errorObj },
      annotations: { title: 'Novel attach generated image', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, imagePath, mime, label, visualBriefId, imagePromptId }) => {
      void sessionId;
      void imagePath;
      void mime;
      void label;
      void visualBriefId;
      void imagePromptId;
      return toolError('NOVEL_ATTACH_GENERATED_IMAGE_DISABLED', 'Filesystem image attachment is disabled in this project.');
    },
  );
}
