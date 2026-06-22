import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import {
  assembleRevisedBlocks,
  chapterBlockLabel,
  checkRewriteLength,
  editingSessionLabel,
  makeFindingId,
  normalizeEditingStep,
  rewriteBlockLabel,
  splitChapterIntoBlocks,
  stableHash,
} from '../novel/editingWorkflow.js';
import {
  EDITORIAL_DECISION_STATUSES,
  EDITORIAL_FINDING_CATEGORIES,
  NOVEL_DRAFT_STATUSES,
  normalizeChapterLabel,
} from '../novel/domain.js';
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

const assetZ = z.object({
  id: z.string(),
  nodeId: z.string(),
  path: z.string(),
  mime: z.string(),
  label: z.string(),
  createdAt: z.string(),
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

function newSessionId(input: { chapterNumber: number; title?: string; manuscriptId?: string; draftId?: string }): string {
  return `editing-${String(input.chapterNumber).padStart(3, '0')}-${stableHash(JSON.stringify(input), 12)}`;
}

async function ensureChapter(chapterNumber: number, title?: string): Promise<kg.GraphNode> {
  const chapterLabel = normalizeChapterLabel(chapterNumber);
  const written = await kg.upsertNode({
    type: 'chapter',
    label: chapterLabel,
    content: title ?? chapterLabel,
    metadata: { chapterNumber, title: title ?? chapterLabel, canonStatus: 'draft' },
    provenance: { source: 'novel_editing_workflow', chapterNumber },
  });
  return written.node;
}

async function getSession(sessionId: string): Promise<kg.GraphNode> {
  const session = await kg.getNodeByTypeLabel('editing_session', sessionId);
  if (!session) throw new Error(`editing_session_not_found: ${sessionId}`);
  return session;
}

async function linkIfNode(fromId: string, toId: string | undefined, kind: string, metadata: Record<string, unknown>, provenance: Record<string, unknown>): Promise<void> {
  if (!toId) return;
  await kg.link({ fromId, toId, kind, metadata, provenance });
}

async function findEditorialFinding(sessionId: string, findingId: string): Promise<kg.GraphNode | null> {
  return kg.getNodeByTypeLabel('editorial_finding', `${sessionId}::finding::${findingId}`);
}

export function registerNovelEditingTools(server: McpServer): void {
  server.registerTool(
    'novel_start_editing_session',
    {
      title: 'Novel start editing session',
      description: 'Creates or resumes an editorial workflow session for a chapter. It is operational state, not Bible canon.',
      inputSchema: {
        chapterNumber: z.number().int().positive(),
        title: z.string().optional(),
        sessionId: z.string().optional(),
        manuscriptId: z.string().optional(),
        draftId: z.string().optional(),
        notes: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), sessionId: z.string().optional(), session: nodeZ.optional(), chapter: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel start editing session', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, title, sessionId, manuscriptId, draftId, notes }) => {
      try {
        const id = sessionId?.trim() || newSessionId({ chapterNumber, title, manuscriptId, draftId });
        const chapter = await ensureChapter(chapterNumber, title);
        const sessionWrite = await kg.upsertNode({
          type: 'editing_session',
          label: id,
          content: editingSessionLabel({ chapterNumber, sessionId: id }),
          metadata: { sessionId: id, chapterNumber, title, manuscriptId, draftId, notes, status: 'active', canonStatus: 'proposal' },
          provenance: { source: 'novel_start_editing_session', sessionId: id, chapterNumber },
        });
        await kg.link({
          fromId: sessionWrite.node.id,
          toId: chapter.id,
          kind: 'applies_to',
          metadata: { sessionId: id, chapterNumber },
          provenance: { source: 'novel_start_editing_session', sessionId: id, chapterNumber },
        });
        return toolStructured({ ok: true, sessionId: id, session: sessionWrite.node, chapter });
      } catch (err) {
        return toolError('NOVEL_START_EDITING_SESSION_FAILED', `novel_start_editing_session failed: ${String(err)}`, { chapterNumber, sessionId });
      }
    },
  );

  server.registerTool(
    'novel_split_chapter_blocks',
    {
      title: 'Novel split chapter blocks',
      description: 'Splits a chapter into bounded editorial blocks and optionally persists them as chapter_block nodes.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
        content: z.string(),
        maxWords: z.number().int().positive().optional(),
        persist: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), blocks: z.array(chapterBlockZ).optional(), blockNodes: z.array(nodeZ).optional(), error: errorObj },
      annotations: { title: 'Novel split chapter blocks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, content, maxWords, persist }) => {
      try {
        const session = await getSession(sessionId);
        const chapter = await ensureChapter(chapterNumber);
        const blocks = splitChapterIntoBlocks(content, maxWords ?? 600);
        if (!persist) return toolStructured({ ok: true, blocks, blockNodes: [] });
        const blockNodes: kg.GraphNode[] = [];
        for (const block of blocks) {
          const written = await kg.upsertNode({
            type: 'chapter_block',
            label: chapterBlockLabel(sessionId, block.blockNumber),
            content: block.text,
            metadata: { sessionId, chapterNumber, ...block, canonStatus: 'proposal' },
            provenance: { source: 'novel_split_chapter_blocks', sessionId, chapterNumber, blockNumber: block.blockNumber },
          });
          blockNodes.push(written.node);
          await kg.link({ fromId: written.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_split_chapter_blocks', sessionId } });
          await kg.link({ fromId: written.node.id, toId: chapter.id, kind: 'applies_to', metadata: { chapterNumber }, provenance: { source: 'novel_split_chapter_blocks', sessionId } });
        }
        return toolStructured({ ok: true, blocks, blockNodes });
      } catch (err) {
        return toolError('NOVEL_SPLIT_CHAPTER_BLOCKS_FAILED', `novel_split_chapter_blocks failed: ${String(err)}`, { sessionId, chapterNumber });
      }
    },
  );

  server.registerTool(
    'novel_save_editorial_findings',
    {
      title: 'Novel save editorial findings',
      description: 'Stores Step 1/2/4/5/6 editorial findings as non-canonical workflow nodes.',
      inputSchema: {
        sessionId: z.string(),
        findings: z.array(editorialFindingInputZ).min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), findingNodes: z.array(nodeZ).optional(), summary: z.record(z.string(), z.number()).optional(), error: errorObj },
      annotations: { title: 'Novel save editorial findings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, findings }) => {
      try {
        const session = await getSession(sessionId);
        const findingNodes: kg.GraphNode[] = [];
        const summary: Record<string, number> = { total: findings.length };
        for (let index = 0; index < findings.length; index++) {
          const finding = findings[index];
          const { step: rawStep, ...findingWithoutStep } = finding;
          const step = normalizeEditingStep(rawStep);
          const findingId = finding.id?.trim() || makeFindingId({ sessionId, step, blockNumber: finding.blockNumber, index: index + 1 });
          summary[`severity:${finding.severity}`] = (summary[`severity:${finding.severity}`] ?? 0) + 1;
          summary[`category:${finding.category}`] = (summary[`category:${finding.category}`] ?? 0) + 1;
          const written = await kg.upsertNode({
            type: 'editorial_finding',
            label: `${sessionId}::finding::${findingId}`,
            content: finding.problem,
            metadata: { ...(finding.metadata ?? {}), ...findingWithoutStep, sessionId, findingId, step, blockNumber: finding.blockNumber, canonStatus: 'proposal' },
            provenance: { source: 'novel_save_editorial_findings', sessionId, step, findingId },
          });
          findingNodes.push(written.node);
          await kg.link({ fromId: written.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId, step }, provenance: { source: 'novel_save_editorial_findings', sessionId, findingId } });
          const block = finding.blockNumber ? await kg.getNodeByTypeLabel('chapter_block', chapterBlockLabel(sessionId, finding.blockNumber)) : null;
          await linkIfNode(written.node.id, block?.id, 'applies_to', { sessionId, blockNumber: finding.blockNumber }, { source: 'novel_save_editorial_findings', sessionId, findingId });
        }
        return toolStructured({ ok: true, findingNodes, summary });
      } catch (err) {
        return toolError('NOVEL_SAVE_EDITORIAL_FINDINGS_FAILED', `novel_save_editorial_findings failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_user_decisions',
    {
      title: 'Novel save user decisions',
      description: 'Stores user approvals/rejections/deferred decisions for editorial findings.',
      inputSchema: {
        sessionId: z.string(),
        decisions: z.array(editorialDecisionInputZ).min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), decisionNodes: z.array(nodeZ).optional(), error: errorObj },
      annotations: { title: 'Novel save user decisions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, decisions }) => {
      try {
        const session = await getSession(sessionId);
        const decisionNodes: kg.GraphNode[] = [];
        for (const decision of decisions) {
          const written = await kg.upsertNode({
            type: 'editorial_decision',
            label: `${sessionId}::decision::${decision.findingId}`,
            content: decision.instructions ?? decision.reason ?? decision.status,
            metadata: { ...(decision.metadata ?? {}), sessionId, ...decision, canonStatus: 'proposal' },
            provenance: { source: 'novel_save_user_decisions', sessionId, findingId: decision.findingId },
          });
          decisionNodes.push(written.node);
          await kg.link({ fromId: written.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_save_user_decisions', sessionId } });
          const finding = await findEditorialFinding(sessionId, decision.findingId);
          await linkIfNode(written.node.id, finding?.id, 'applies_to', { sessionId, findingId: decision.findingId }, { source: 'novel_save_user_decisions', sessionId });
        }
        return toolStructured({ ok: true, decisionNodes });
      } catch (err) {
        return toolError('NOVEL_SAVE_USER_DECISIONS_FAILED', `novel_save_user_decisions failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_rewrite_block',
    {
      title: 'Novel save rewrite block',
      description: 'Stores a rewritten block only if its length stays within the mandated 85%-140% range.',
      inputSchema: {
        sessionId: z.string(),
        blockNumber: z.number().int().positive(),
        originalText: z.string(),
        revisedText: z.string(),
        appliedFindingIds: z.array(z.string()).optional(),
        approved: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), rewrite: nodeZ.optional(), lengthCheck: rewriteLengthCheckZ.optional(), error: errorObj },
      annotations: { title: 'Novel save rewrite block', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, blockNumber, originalText, revisedText, appliedFindingIds, approved }) => {
      try {
        const session = await getSession(sessionId);
        const lengthCheck = checkRewriteLength(originalText, revisedText);
        if (!lengthCheck.valid) return toolError('NOVEL_REWRITE_LENGTH_INVALID', 'Rewrite block is outside the allowed 85%-140% length range.', { lengthCheck, sessionId, blockNumber });
        const written = await kg.upsertNode({
          type: 'rewrite_block',
          label: rewriteBlockLabel(sessionId, blockNumber),
          content: revisedText,
          metadata: { sessionId, blockNumber, originalHash: stableHash(originalText), revisedHash: stableHash(revisedText), lengthCheck, approved: Boolean(approved), appliedFindingIds: appliedFindingIds ?? [], canonStatus: 'proposal' },
          provenance: { source: 'novel_save_rewrite_block', sessionId, blockNumber },
        });
        await kg.link({ fromId: written.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_save_rewrite_block', sessionId } });
        const block = await kg.getNodeByTypeLabel('chapter_block', chapterBlockLabel(sessionId, blockNumber));
        await linkIfNode(written.node.id, block?.id, 'revises', { sessionId, blockNumber }, { source: 'novel_save_rewrite_block', sessionId });
        for (const findingId of appliedFindingIds ?? []) {
          const finding = await findEditorialFinding(sessionId, findingId);
          await linkIfNode(written.node.id, finding?.id, 'applies_to', { sessionId, findingId }, { source: 'novel_save_rewrite_block', sessionId });
        }
        return toolStructured({ ok: true, rewrite: written.node, lengthCheck });
      } catch (err) {
        return toolError('NOVEL_SAVE_REWRITE_BLOCK_FAILED', `novel_save_rewrite_block failed: ${String(err)}`, { sessionId, blockNumber });
      }
    },
  );

  server.registerTool(
    'novel_assemble_chapter_revision',
    {
      title: 'Novel assemble chapter revision',
      description: 'Assembles saved rewrite_block nodes into a chapter revision and stores it as a draft node.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
        title: z.string().optional(),
        expectedBlocks: z.number().int().positive().optional(),
      },
      outputSchema: { ok: z.boolean(), content: z.string().optional(), revision: nodeZ.optional(), missingBlocks: z.array(z.number()).optional(), error: errorObj },
      annotations: { title: 'Novel assemble chapter revision', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, title, expectedBlocks }) => {
      try {
        const session = await getSession(sessionId);
        const rewrites = await kg.listNodesByTypeLabelPrefix('rewrite_block', `${sessionId}::rewrite::B`);
        const blocks = rewrites.map((node) => ({ blockNumber: Number(node.metadata.blockNumber), text: node.content })).filter((block) => Number.isFinite(block.blockNumber));
        const expectedMissing = expectedBlocks ? Array.from({ length: expectedBlocks }, (_value, index) => index + 1).filter((blockNumber) => !blocks.some((block) => block.blockNumber === blockNumber)) : [];
        if (expectedMissing.length) return toolStructured({ ok: false, missingBlocks: expectedMissing });
        const content = assembleRevisedBlocks(blocks);
        const revision = await kg.upsertNode({
          type: 'chapter_draft',
          label: `${sessionId}::assembled-revision`,
          content,
          metadata: { sessionId, chapterNumber, title: title ?? normalizeChapterLabel(chapterNumber), status: 'revision', canonStatus: 'draft', blockCount: blocks.length },
          provenance: { source: 'novel_assemble_chapter_revision', sessionId, chapterNumber },
        });
        await kg.link({ fromId: revision.node.id, toId: session.id, kind: 'derived_from', metadata: { sessionId }, provenance: { source: 'novel_assemble_chapter_revision', sessionId } });
        return toolStructured({ ok: true, content, revision: revision.node, missingBlocks: [] });
      } catch (err) {
        return toolError('NOVEL_ASSEMBLE_CHAPTER_REVISION_FAILED', `novel_assemble_chapter_revision failed: ${String(err)}`, { sessionId, chapterNumber });
      }
    },
  );

  server.registerTool(
    'novel_save_seam_review',
    {
      title: 'Novel save seam review',
      description: 'Stores Step 4 seam/saldature review for the unified chapter.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive().optional(),
        summary: z.string(),
        findings: z.array(z.string()).optional(),
        approved: z.boolean().optional(),
      },
      outputSchema: { ok: z.boolean(), seamReview: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel save seam review', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, summary, findings, approved }) => {
      try {
        const session = await getSession(sessionId);
        const written = await kg.upsertNode({
          type: 'seam_review',
          label: `${sessionId}::seam-review`,
          content: summary,
          metadata: { sessionId, chapterNumber, findings: findings ?? [], approved: Boolean(approved), canonStatus: 'proposal' },
          provenance: { source: 'novel_save_seam_review', sessionId, chapterNumber },
        });
        await kg.link({ fromId: written.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_save_seam_review', sessionId } });
        return toolStructured({ ok: true, seamReview: written.node });
      } catch (err) {
        return toolError('NOVEL_SAVE_SEAM_REVIEW_FAILED', `novel_save_seam_review failed: ${String(err)}`, { sessionId });
      }
    },
  );

  server.registerTool(
    'novel_save_final_chapter',
    {
      title: 'Novel save final chapter',
      description: 'Stores the final reviewed chapter text as an approved draft, not as Bible canon.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
        title: z.string().optional(),
        content: z.string(),
        status: draftStatusZ.optional(),
      },
      outputSchema: { ok: z.boolean(), finalDraft: nodeZ.optional(), chapter: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel save final chapter', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, title, content, status }) => {
      try {
        const session = await getSession(sessionId);
        const chapter = await ensureChapter(chapterNumber, title);
        const finalDraft = await kg.upsertNode({
          type: 'chapter_draft',
          label: `${sessionId}::final`,
          content,
          metadata: { sessionId, chapterNumber, title: title ?? normalizeChapterLabel(chapterNumber), status: status ?? 'approved', canonStatus: 'draft', finalHash: stableHash(content) },
          provenance: { source: 'novel_save_final_chapter', sessionId, chapterNumber },
        });
        await kg.link({ fromId: finalDraft.node.id, toId: session.id, kind: 'derived_from', metadata: { sessionId }, provenance: { source: 'novel_save_final_chapter', sessionId } });
        await kg.link({ fromId: finalDraft.node.id, toId: chapter.id, kind: 'applies_to', metadata: { chapterNumber }, provenance: { source: 'novel_save_final_chapter', sessionId } });
        return toolStructured({ ok: true, finalDraft: finalDraft.node, chapter });
      } catch (err) {
        return toolError('NOVEL_SAVE_FINAL_CHAPTER_FAILED', `novel_save_final_chapter failed: ${String(err)}`, { sessionId, chapterNumber });
      }
    },
  );

  server.registerTool(
    'novel_create_visual_brief',
    {
      title: 'Novel create visual brief',
      description: 'Stores Step 6 visual brief and image prompt. It does not generate the image.',
      inputSchema: {
        sessionId: z.string(),
        chapterNumber: z.number().int().positive(),
        sceneSummary: z.string(),
        characters: z.array(z.string()).optional(),
        promptIt: z.string(),
        promptEn: z.string().optional(),
        styleModifier: z.string().optional(),
        sourceText: z.string().optional(),
        metadata: jsonObj.optional(),
      },
      outputSchema: { ok: z.boolean(), visualBrief: nodeZ.optional(), imagePrompt: nodeZ.optional(), error: errorObj },
      annotations: { title: 'Novel create visual brief', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, chapterNumber, sceneSummary, characters, promptIt, promptEn, styleModifier, sourceText, metadata }) => {
      try {
        const session = await getSession(sessionId);
        const brief = await kg.upsertNode({
          type: 'visual_brief',
          label: `${sessionId}::visual-brief::${stableHash(sceneSummary, 10)}`,
          content: sceneSummary,
          metadata: { ...(metadata ?? {}), sessionId, chapterNumber, characters: characters ?? [], sourceText, canonStatus: 'proposal' },
          provenance: { source: 'novel_create_visual_brief', sessionId, chapterNumber },
        });
        const prompt = await kg.upsertNode({
          type: 'image_prompt',
          label: `${brief.node.label}::prompt`,
          content: [promptIt, promptEn, styleModifier].filter(Boolean).join('\n\n'),
          metadata: { sessionId, chapterNumber, promptIt, promptEn, styleModifier, canonStatus: 'proposal' },
          provenance: { source: 'novel_create_visual_brief', sessionId, chapterNumber },
        });
        await kg.link({ fromId: brief.node.id, toId: session.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_create_visual_brief', sessionId } });
        await kg.link({ fromId: prompt.node.id, toId: brief.node.id, kind: 'part_of', metadata: { sessionId }, provenance: { source: 'novel_create_visual_brief', sessionId } });
        return toolStructured({ ok: true, visualBrief: brief.node, imagePrompt: prompt.node });
      } catch (err) {
        return toolError('NOVEL_CREATE_VISUAL_BRIEF_FAILED', `novel_create_visual_brief failed: ${String(err)}`, { sessionId, chapterNumber });
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
      outputSchema: { ok: z.boolean(), image: nodeZ.optional(), asset: assetZ.optional(), error: errorObj },
      annotations: { title: 'Novel attach generated image', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sessionId, imagePath, mime, label, visualBriefId, imagePromptId }) => {
      try {
        await getSession(sessionId);
        const image = await kg.upsertNode({
          type: 'generated_image',
          label: `${sessionId}::image::${stableHash(imagePath, 12)}`,
          content: label ?? imagePath,
          metadata: { sessionId, imagePath, mime: mime ?? 'image/png', label, canonStatus: 'proposal' },
          provenance: { source: 'novel_attach_generated_image', sessionId },
        });
        const asset = await kg.attachAsset(image.node.id, { path: imagePath, mime: mime ?? 'image/png', label: label ?? 'generated image' });
        await linkIfNode(image.node.id, visualBriefId, 'derived_from', { sessionId }, { source: 'novel_attach_generated_image', sessionId });
        await linkIfNode(image.node.id, imagePromptId, 'derived_from', { sessionId }, { source: 'novel_attach_generated_image', sessionId });
        return toolStructured({ ok: true, image: image.node, asset });
      } catch (err) {
        return toolError('NOVEL_ATTACH_GENERATED_IMAGE_FAILED', `novel_attach_generated_image failed: ${String(err)}`, { sessionId, imagePath });
      }
    },
  );
}
