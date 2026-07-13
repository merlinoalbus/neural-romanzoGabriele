import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import * as kg from '../graph/neo4jStore.js';
import { NOVEL_DRAFT_STATUSES, NOVEL_SOURCE_TYPES, normalizeChapterLabel } from '../novel/domain.js';
import { buildOutlinePlan, type OutlineEntry, type OutlinePlan } from '../novel/outline.js';
import { auditChapterContent } from '../novel/context.js';
import { normalizeWorkingDraftContent, workingDraftContentHash } from '../novel/workingDraft.js';
import { withWorkingDraftChapterLock } from '../novel/workingDraftService.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

const jsonObj = z.record(z.string(), z.unknown());

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

const savedSourceZ = z.object({
  saved: z.boolean(),
  path: z.string().optional(),
  metadataPath: z.string().optional(),
  bytes: z.number().optional(),
  error: z.string().optional(),
});

const outlineEntryZ = z.object({
  number: z.string(),
  title: z.string(),
  page: z.number().optional(),
  depth: z.number(),
  parentNumber: z.string().optional(),
  order: z.number(),
  nodeType: z.string(),
  label: z.string(),
  chapterNumber: z.number().optional(),
  chapterKind: z.enum(['prologue', 'chapter', 'epilogue']).optional(),
});

const ingestSummaryZ = z.object({
  sourceId: z.string(),
  sourceType: z.string(),
  entries: z.number(),
  nodesPlanned: z.number(),
  edgesPlanned: z.number(),
  nodesWritten: z.number(),
  edgesWritten: z.number(),
});

const draftStatusZ = z.enum(NOVEL_DRAFT_STATUSES);

function outlineEntryPreview(entry: OutlineEntry): z.infer<typeof outlineEntryZ> {
  return {
    number: entry.number,
    title: entry.title,
    page: entry.page,
    depth: entry.depth,
    parentNumber: entry.parentNumber,
    order: entry.order,
    nodeType: entry.nodeType,
    label: entry.label,
    chapterNumber: entry.chapterNumber,
    chapterKind: entry.chapterKind,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

async function writeOutlinePlan(plan: OutlinePlan, input: { title?: string; content: string; toolName: string }): Promise<{
  outline: kg.GraphNode;
  document: kg.GraphNode;
  nas?: { saved: boolean; path?: string; metadataPath?: string; bytes?: number; error?: string };
  nodesWritten: number;
  edgesWritten: number;
}> {
  const documentResult = await kg.ingestDocument({
    sourceId: plan.sourceId,
    title: input.title ?? plan.sourceId,
    sourceType: plan.sourceType,
    content: input.content,
    metadata: {
      sourceType: plan.sourceType,
      title: input.title ?? plan.sourceId,
      outlineEntryCount: plan.entries.length,
    },
    provenance: { source: input.toolName, sourceId: plan.sourceId },
  });

  const rootWrite = await kg.upsertNode({
    type: plan.root.type,
    label: plan.root.label,
    content: plan.root.content,
    metadata: plan.root.metadata,
    provenance: { ...plan.root.provenance, source: input.toolName },
  });

  const nodeByKey = new Map<string, kg.GraphNode>([[plan.root.key, rootWrite.node]]);
  let nodesWritten = 1;
  for (const planned of plan.nodes) {
    const written = await kg.upsertNode({
      type: planned.type,
      label: planned.label,
      content: planned.content,
      metadata: planned.metadata,
      provenance: { ...planned.provenance, source: input.toolName },
    });
    nodeByKey.set(planned.key, written.node);
    nodesWritten++;
  }

  let edgesWritten = 0;
  await kg.link({
    fromId: rootWrite.node.id,
    toId: documentResult.document.id,
    kind: 'derived_from',
    metadata: { sourceId: plan.sourceId, sourceType: plan.sourceType },
    provenance: { source: input.toolName, sourceId: plan.sourceId },
  });
  edgesWritten++;

  for (const planned of plan.edges) {
    const from = nodeByKey.get(planned.fromKey);
    const to = nodeByKey.get(planned.toKey);
    if (!from || !to) continue;
    await kg.link({
      fromId: from.id,
      toId: to.id,
      kind: planned.kind,
      metadata: planned.metadata,
      provenance: { ...planned.provenance, source: input.toolName },
    });
    edgesWritten++;
  }

  return { outline: rootWrite.node, document: documentResult.document, nas: documentResult.nas, nodesWritten, edgesWritten };
}

export function registerNovelIngestionTools(server: McpServer): void {
  server.registerTool(
    'novel_ingest_outline',
    {
      title: 'Novel ingest outline',
      description: 'Parses and imports only the Bible outline structure. It never invents narrative content.',
      inputSchema: {
        sourceId: z.string(),
        title: z.string().optional(),
        content: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: ingestSummaryZ.optional(),
        outline: nodeZ.optional(),
        document: nodeZ.optional(),
        nas: savedSourceZ.optional(),
        entries: z.array(outlineEntryZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel ingest outline', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, title, content }) => {
      try {
        if (!content.trim()) throw new Error('invalid_outline: content is required');
        const plan = buildOutlinePlan({ sourceId, title, content, sourceType: NOVEL_SOURCE_TYPES.outline });
        const written = await writeOutlinePlan(plan, { title, content, toolName: 'novel_ingest_outline' });
        return toolStructured({
          ok: true,
          summary: {
            sourceId: plan.sourceId,
            sourceType: plan.sourceType,
            entries: plan.entries.length,
            nodesPlanned: plan.nodes.length + 1,
            edgesPlanned: plan.edges.length + 1,
            nodesWritten: written.nodesWritten,
            edgesWritten: written.edgesWritten,
          },
          outline: written.outline,
          document: written.document,
          nas: written.nas,
          entries: plan.entries.map(outlineEntryPreview),
        });
      } catch (err) {
        return toolError('NOVEL_INGEST_OUTLINE_FAILED', `novel_ingest_outline failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_ingest_bible',
    {
      title: 'Novel ingest bible',
      description: 'Stores the complete Bible source when provided and derives only numbered structural headings.',
      inputSchema: {
        sourceId: z.string(),
        title: z.string().optional(),
        content: z.string(),
      },
      outputSchema: {
        ok: z.boolean(),
        summary: ingestSummaryZ.optional(),
        outline: nodeZ.optional(),
        document: nodeZ.optional(),
        nas: savedSourceZ.optional(),
        entries: z.array(outlineEntryZ).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel ingest bible', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sourceId, title, content }) => {
      try {
        if (!content.trim()) throw new Error('invalid_bible: content is required');
        const plan = buildOutlinePlan({ sourceId, title, content, sourceType: NOVEL_SOURCE_TYPES.bible });
        const written = await writeOutlinePlan(plan, { title, content, toolName: 'novel_ingest_bible' });
        return toolStructured({
          ok: true,
          summary: {
            sourceId: plan.sourceId,
            sourceType: plan.sourceType,
            entries: plan.entries.length,
            nodesPlanned: plan.nodes.length + 1,
            edgesPlanned: plan.edges.length + 1,
            nodesWritten: written.nodesWritten,
            edgesWritten: written.edgesWritten,
          },
          outline: written.outline,
          document: written.document,
          nas: written.nas,
          entries: plan.entries.map(outlineEntryPreview),
        });
      } catch (err) {
        return toolError('NOVEL_INGEST_BIBLE_FAILED', `novel_ingest_bible failed: ${String(err)}`, { sourceId });
      }
    },
  );

  server.registerTool(
    'novel_ingest_chapter_draft',
    {
      title: 'Novel ingest chapter draft',
      description: 'Stores a real chapter draft and links it to a stable chapter node. It does not create narrative facts from the prose.',
      inputSchema: {
        chapterNumber: z.number().int().positive(),
        title: z.string().optional(),
        content: z.string(),
        draftId: z.string().optional(),
        status: draftStatusZ.optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        chapter: nodeZ.optional(),
        draft: nodeZ.optional(),
        document: nodeZ.optional(),
        nas: savedSourceZ.optional(),
        chunkCount: z.number().optional(),
        linterStatus: z.enum(['ok', 'failed']).optional(),
        linterError: z.string().optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel ingest chapter draft', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, title, content, draftId, status }) => withWorkingDraftChapterLock(chapterNumber, async () => {
      try {
        if (!content.trim()) throw new Error('invalid_chapter_draft: content is required');
        const normalizedContent = normalizeWorkingDraftContent(content);
        const proposedHash = workingDraftContentHash(normalizedContent);
        const chapterLabel = normalizeChapterLabel(chapterNumber);
        // Stable per-chapter identifiers: re-ingesting a revised draft of the SAME chapter must
        // update the existing document/draft node in place, never stratify a new one alongside it.
        // `draftId`, when given, is kept only as informational metadata (e.g. "which round"), not
        // as part of the node's identity.
        const sourceId = `chapter-${String(chapterNumber).padStart(3, '0')}-draft`;
        const existingChapter = await kg.getChapterByNumber(chapterNumber);
        if (existingChapter?.metadata.canonStatus === 'finalizing') {
          return toolError('CHAPTER_FINALIZATION_IN_PROGRESS', 'Complete or retry the existing chapter finalization before ingesting another draft generation.', {
            chapterNumber,
            finalizingSessionId: existingChapter.metadata.lastFinalizedSessionId,
            finalHash: existingChapter.metadata.finalHash,
          });
        }
        let existingWorkingDraft: Awaited<ReturnType<typeof kg.getWorkingDraft>> = null;
        let strandedDraft: kg.GraphNode | null = null;
        try {
          existingWorkingDraft = await kg.getWorkingDraft(chapterNumber);
        } catch (err) {
          if (!(err instanceof kg.WorkingDraftDocumentMissingError)) throw err;
          // A previous ingest may have stopped after creating the stable draft anchor but before
          // linking its document. Recover only when the stranded anchor proves that it contains
          // this exact text; never overwrite an unknown partial state.
          strandedDraft = await kg.getNodeByTypeLabel('chapter_draft', `${chapterLabel} draft`);
          const recordedHash = typeof strandedDraft?.metadata.contentHash === 'string'
            ? strandedDraft.metadata.contentHash.toLowerCase()
            : '';
          const strandedHash = strandedDraft?.content
            ? workingDraftContentHash(normalizeWorkingDraftContent(strandedDraft.content))
            : '';
          const hasRecordedHash = /^[a-f0-9]{64}$/.test(recordedHash);
          const hashEvidenceConflicts = hasRecordedHash && Boolean(strandedHash) && recordedHash !== strandedHash;
          const recoverableHash = strandedHash || (hasRecordedHash ? recordedHash : '');
          if (!strandedDraft || hashEvidenceConflicts || recoverableHash !== proposedHash) {
            return toolError('DRAFT_STRUCTURE_REPAIR_REQUIRED', 'A partial working draft exists without its document and cannot be repaired safely from different text.', {
              chapterNumber,
              draftNodeId: strandedDraft?.id,
              currentContentHash: recoverableHash || undefined,
              recordedContentHash: recordedHash || undefined,
              hashEvidenceConflicts,
              proposedContentHash: proposedHash,
            });
          }
        }
        if (existingWorkingDraft && existingWorkingDraft.contentHash !== proposedHash) {
          return toolError('DRAFT_VERSION_CONFLICT', 'The working draft already changed. Read it and update it with novel_update_working_draft using its current hash and revision.', {
            chapterNumber,
            current: existingWorkingDraft,
          });
        }
        const documentResult = await kg.ingestDocument({
          sourceId,
          title: title ?? chapterLabel,
          sourceType: NOVEL_SOURCE_TYPES.chapterDraft,
          content: normalizedContent,
          metadata: {
            sourceType: NOVEL_SOURCE_TYPES.chapterDraft,
            chapterNumber,
            title: title ?? chapterLabel,
            draftId: draftId?.trim() || undefined,
            status: status ?? 'draft',
          },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        const chapterWrite = existingChapter
          ? { node: existingChapter, created: false }
          : await kg.upsertNode({
              type: 'chapter',
              label: chapterLabel,
              content: title ?? chapterLabel,
              metadata: {
                chapterNumber,
                title: title ?? chapterLabel,
                canonStatus: 'draft',
              },
              provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
            });
        const draftWrite = await kg.upsertNode({
          type: 'chapter_draft',
          label: `${chapterLabel} draft`,
          content: existingWorkingDraft?.content ?? strandedDraft?.content ?? normalizedContent,
          metadata: {
            sourceId,
            documentId: documentResult.document.id,
            chapterNumber,
            title: title ?? chapterLabel,
            draftId: draftId?.trim() || undefined,
            status: status ?? 'draft',
            wordCount: countWords(normalizedContent),
            charCount: normalizedContent.length,
            contentHash: proposedHash,
            revision: existingWorkingDraft?.revision ?? Number(strandedDraft?.metadata.revision ?? 1),
            canonStatus: 'draft',
          },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        await kg.link({
          fromId: draftWrite.node.id,
          toId: chapterWrite.node.id,
          kind: 'part_of',
          metadata: { chapterNumber, draftId: draftId?.trim() || undefined },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        await kg.link({
          fromId: draftWrite.node.id,
          toId: documentResult.document.id,
          kind: 'derived_from',
          metadata: { chapterNumber, draftId: draftId?.trim() || undefined },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        const initializedDraft = await kg.initializeWorkingDraftProjection({ chapterNumber, content: normalizedContent, author: 'ingest' });
        const currentDraftNode = (await kg.getNodeById(initializedDraft.draftNodeId)) ?? draftWrite.node;

        // --- AUTONOMOUS LINTING ON INGEST ---
        let linterStatus: 'ok' | 'failed' = 'ok';
        let linterError: string | undefined;
        try {
          const [characters, styleRules, worldRules, themes, timelineEvents, traitsRes, secretsRes] = await Promise.all([
            kg.listNodesByType('character', { limit: 500 }),
            kg.listNodesByType('style_rule', { limit: 500 }),
            kg.listNodesByType('world_rule', { limit: 500 }),
            kg.listNodesByType('theme', { limit: 500 }),
            kg.listNodesByType('timeline_event', { limit: 500 }),
            kg.runQuery(`
              MATCH (t:Entity {projectId: $pid, type: 'character_trait'})-[r:REL]-(c:Entity {projectId: $pid, type: 'character'})
              WHERE r.kind IN ['applies_to', 'part_of', 'derived_from']
              RETURN DISTINCT t.id as id, t.label as label, t.content as content, c.id as charId, c.label as charLabel
            `, { pid: config.projectId }),
            kg.runQuery(`
              MATCH (s:Entity {projectId: $pid, type: 'secret'})-[r:REL]-(c:Entity {projectId: $pid, type: 'character'})
              RETURN DISTINCT s.id as id, s.label as label, s.content as content, c.id as charId, c.label as charLabel, r.kind as relKind
            `, { pid: config.projectId }),
          ]);

          const characterTraits = traitsRes.map((r) => ({
            id: r.get('id') as string,
            label: r.get('label') as string,
            content: r.get('content') as string,
            charId: r.get('charId') as string,
            charLabel: r.get('charLabel') as string,
          }));

          const characterSecrets = secretsRes.map((r) => ({
            id: r.get('id') as string,
            label: r.get('label') as string,
            content: r.get('content') as string,
            charId: r.get('charId') as string,
            charLabel: r.get('charLabel') as string,
            relKind: r.get('relKind') as string,
          }));

          const audit = auditChapterContent({
            chapterNumber,
            content,
            chapter: chapterWrite.node,
            characters,
            styleRules,
            worldRules,
            themes,
            timelineEvents,
            characterTraits,
            characterSecrets,
          });

          // Rimuovi eventuali continuity_finding vecchi per questo capitolo prima di inserire quelli nuovi
          await kg.clearWorkingDraftLinterFindings(chapterNumber);

          // Scrivi i nuovi warning trovati
          for (const finding of audit.findings) {
            if (finding.severity === 'warning' || finding.severity === 'error') {
              // Dedicated namespace prevents an autonomous linter upsert from ever taking over
              // a manually-authored continuity finding that happens to use the same code/title.
              const findingLabel = `draft-linter:${sourceId}:${finding.code}`;
              const cfNode = await kg.upsertNode({
                type: 'continuity_finding',
                label: findingLabel,
                content: finding.message,
                metadata: {
                  chapterNumber,
                  code: finding.code,
                  severity: finding.severity,
                  evidence: finding.evidence || {},
                  contentHash: initializedDraft.contentHash,
                  revision: initializedDraft.revision,
                  draftOwned: true,
                },
                provenance: { source: 'autonomous_ingest_linter', chapterNumber, sourceId },
              });

              await kg.link({
                fromId: cfNode.node.id,
                toId: chapterWrite.node.id,
                kind: 'applies_to',
                metadata: { chapterNumber },
                provenance: { source: 'autonomous_ingest_linter', chapterNumber, sourceId },
              });
              // Explicit ownership lets final cleanup remove draft-only linter findings without
              // touching manually-authored or cross-chapter continuity findings.
              await kg.link({
                fromId: cfNode.node.id,
                toId: currentDraftNode.id,
                kind: 'applies_to',
                metadata: { chapterNumber, draftOwned: true },
                provenance: { source: 'autonomous_ingest_linter', chapterNumber, sourceId },
              });
            }
          }
        } catch (linterErr) {
          linterStatus = 'failed';
          linterError = String(linterErr);
          console.error('Autonomous ingest linter failed:', linterErr);
        }

        try {
          await kg.markWorkingDraftAudit({
            chapterNumber,
            expectedContentHash: initializedDraft.contentHash,
            expectedRevision: initializedDraft.revision,
            status: linterStatus === 'ok' ? 'passed' : 'failed',
            error: linterError,
          });
        } catch (auditMarkerErr) {
          linterStatus = 'failed';
          linterError = linterError
            ? `${linterError}; audit marker failed: ${String(auditMarkerErr)}`
            : `audit marker failed: ${String(auditMarkerErr)}`;
          console.error('Working draft audit marker failed:', auditMarkerErr);
        }

        return toolStructured({
          ok: true,
          chapter: chapterWrite.node,
          draft: currentDraftNode,
          document: documentResult.document,
          nas: documentResult.nas,
          chunkCount: documentResult.chunkCount,
          linterStatus,
          linterError,
        });
      } catch (err) {
        return toolError('NOVEL_INGEST_CHAPTER_DRAFT_FAILED', `novel_ingest_chapter_draft failed: ${String(err)}`, { chapterNumber, draftId });
      }
    }),
  );
}
