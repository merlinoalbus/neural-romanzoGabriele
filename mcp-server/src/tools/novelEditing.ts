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
  deleteEditingSession,
  readEditingSession,
  writeEditingSession,
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

async function ensureChapter(identifier: { chapterNumber?: number; role?: ChapterSectionRole }, title?: string): Promise<kg.GraphNode> {
  const chapterLabel = resolveChapterSectionLabel(identifier);
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
    'novel_start_editing_session',
    {
      title: 'Novel start editing session',
      description:
        'Creates or resumes an editorial workflow session for a chapter, Prologo or Epilogo (pass chapterNumber for a numbered chapter, or role for Prologo/Epilogo). Session state (blocks, findings, decisions, rewrites, seam review, visual briefs) lives in a file, never as a graph node — the neural model only ever contains the canonical chapter itself.',
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
        const state = await readEditingSession(sessionId);
        await writeEditingSession({ ...state, blocks });
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
        const state = await readEditingSession(sessionId);
        const now = new Date().toISOString();
        const summary: Record<string, number> = { total: findings.length };
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
        const nextFindings = [...byId.values()];
        await writeEditingSession({ ...state, findings: nextFindings });
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
        const state = await readEditingSession(sessionId);
        const now = new Date().toISOString();
        const byFindingId = new Map(state.decisions.map((decision) => [decision.findingId, decision]));
        for (const decision of decisions) {
          byFindingId.set(decision.findingId, { ...decision, updatedAt: now });
        }
        const nextDecisions = [...byFindingId.values()];
        await writeEditingSession({ ...state, decisions: nextDecisions });
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
        const state = await readEditingSession(sessionId);
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
        const nextRewrites = [...state.rewrites.filter((rewrite) => rewrite.blockNumber !== blockNumber), record];
        await writeEditingSession({ ...state, rewrites: nextRewrites });
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
        const state = await readEditingSession(sessionId);
        const blocks = state.rewrites.map((rewrite) => ({ blockNumber: rewrite.blockNumber, text: rewrite.revisedText }));
        const expectedMissing = expectedBlocks
          ? Array.from({ length: expectedBlocks }, (_value, index) => index + 1).filter((blockNumber) => !blocks.some((block) => block.blockNumber === blockNumber))
          : [];
        if (expectedMissing.length) return toolStructured({ ok: false, missingBlocks: expectedMissing });
        const content = assembleRevisedBlocks(blocks);
        await writeEditingSession({
          ...state,
          assembledRevision: { content, blockCount: blocks.length, assembledAt: new Date().toISOString() },
        });
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
        const state = await readEditingSession(sessionId);
        const record = { summary, findings: findings ?? [], approved: Boolean(approved), updatedAt: new Date().toISOString() };
        await writeEditingSession({ ...state, seamReview: record });
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
      outputSchema: { ok: z.boolean(), chapter: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel save final chapter', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, role, title, content, status }) => {
      try {
        if (chapterNumber === undefined && !role) {
          return toolError('NOVEL_SAVE_FINAL_CHAPTER_BAD_INPUT', 'Provide chapterNumber (numbered chapter) or role (prologo/epilogo).');
        }
        await readEditingSession(sessionId); // throws EditingSessionNotFoundError if sessionId is invalid
        const chapterLabel = resolveChapterSectionLabel({ chapterNumber, role });
        const finalHash = stableHash(content);
        const written = await kg.upsertNode({
          type: 'chapter',
          label: chapterLabel,
          content,
          metadata: {
            chapterNumber,
            role,
            title: title ?? chapterLabel,
            canonStatus: 'canonical',
            editorialStatus: status ?? 'approved',
            finalHash,
            revisionHistory: [{ sessionId, finalHash, editedAt: new Date().toISOString() }],
          },
          provenance: { source: 'novel_save_final_chapter', sessionId, chapterNumber, role },
        });
        await embedNodesInline([written.node.id]);
        await deleteEditingSession(sessionId);
        return toolStructured({ ok: true, chapter: written.node });
      } catch (err) {
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
        const state = await readEditingSession(sessionId);
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
        await writeEditingSession({ ...state, visualBriefs: [...state.visualBriefs, record] });
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
