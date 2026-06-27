import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { NOVEL_DRAFT_STATUSES, NOVEL_SOURCE_TYPES, normalizeChapterLabel } from '../novel/domain.js';
import { buildOutlinePlan, type OutlineEntry, type OutlinePlan } from '../novel/outline.js';
import { auditChapterContent } from '../novel/context.js';
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

function draftKey(input: { chapterNumber: number; title?: string; content: string; draftId?: string }): string {
  if (input.draftId?.trim()) return input.draftId.trim();
  const hash = crypto
    .createHash('sha256')
    .update(String(input.chapterNumber))
    .update('\n')
    .update(input.title ?? '')
    .update('\n')
    .update(input.content)
    .digest('hex')
    .slice(0, 16);
  return `auto-${hash}`;
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
        error: errorObj,
      },
      annotations: { title: 'Novel ingest chapter draft', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, title, content, draftId, status }) => {
      try {
        if (!content.trim()) throw new Error('invalid_chapter_draft: content is required');
        const chapterLabel = normalizeChapterLabel(chapterNumber);
        const key = draftKey({ chapterNumber, title, content, draftId });
        const sourceId = `chapter-${String(chapterNumber).padStart(3, '0')}-${key}`;
        const documentResult = await kg.ingestDocument({
          sourceId,
          title: title ?? chapterLabel,
          sourceType: NOVEL_SOURCE_TYPES.chapterDraft,
          content,
          metadata: {
            sourceType: NOVEL_SOURCE_TYPES.chapterDraft,
            chapterNumber,
            title: title ?? chapterLabel,
            draftId: key,
            status: status ?? 'draft',
          },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        const chapterWrite = await kg.upsertNode({
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
          label: `${chapterLabel} draft ${key}`,
          content: title ?? chapterLabel,
          metadata: {
            sourceId,
            documentId: documentResult.document.id,
            chapterNumber,
            title: title ?? chapterLabel,
            draftId: key,
            status: status ?? 'draft',
            wordCount: countWords(content),
            charCount: content.length,
            canonStatus: 'draft',
          },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        await kg.link({
          fromId: draftWrite.node.id,
          toId: chapterWrite.node.id,
          kind: 'part_of',
          metadata: { chapterNumber, draftId: key },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });
        await kg.link({
          fromId: draftWrite.node.id,
          toId: documentResult.document.id,
          kind: 'derived_from',
          metadata: { chapterNumber, draftId: key },
          provenance: { source: 'novel_ingest_chapter_draft', sourceId, chapterNumber },
        });

        // --- AUTONOMOUS LINTING ON INGEST ---
        try {
          const [characters, styleRules, worldRules, themes, timelineEvents, traitsRes, secretsRes] = await Promise.all([
            kg.listNodesByType('character', { limit: 500 }),
            kg.listNodesByType('style_rule', { limit: 500 }),
            kg.listNodesByType('world_rule', { limit: 500 }),
            kg.listNodesByType('theme', { limit: 500 }),
            kg.listNodesByType('timeline_event', { limit: 500 }),
            kg.runQuery(`
              MATCH (t:Entity {type: 'character_trait'})-[:applies_to|part_of|derived_from]-(c:Entity {type: 'character'}) 
              RETURN t.id as id, t.label as label, t.content as content, c.id as charId, c.label as charLabel
            `, {}),
            kg.runQuery(`
              MATCH (s:Entity {type: 'secret'})-[r]-(c:Entity {type: 'character'}) 
              RETURN s.id as id, s.label as label, s.content as content, c.id as charId, c.label as charLabel, type(r) as relKind
            `, {}),
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
          await kg.runQuery(`
            MATCH (cf:Entity {type: 'continuity_finding'})-[:applies_to]->(c:Entity {type: 'chapter', label: $chapterLabel})
            DETACH DELETE cf
          `, { chapterLabel });

          // Scrivi i nuovi warning trovati
          for (const finding of audit.findings) {
            if (finding.severity === 'warning' || finding.severity === 'error') {
              const findingLabel = `${finding.code}:${chapterLabel}`;
              const cfNode = await kg.upsertNode({
                type: 'continuity_finding',
                label: findingLabel,
                content: finding.message,
                metadata: {
                  chapterNumber,
                  code: finding.code,
                  severity: finding.severity,
                  evidence: finding.evidence || {},
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
            }
          }
        } catch (linterErr) {
          console.error('Autonomous ingest linter failed:', linterErr);
        }

        return toolStructured({
          ok: true,
          chapter: chapterWrite.node,
          draft: draftWrite.node,
          document: documentResult.document,
          nas: documentResult.nas,
          chunkCount: documentResult.chunkCount,
        });
      } catch (err) {
        return toolError('NOVEL_INGEST_CHAPTER_DRAFT_FAILED', `novel_ingest_chapter_draft failed: ${String(err)}`, { chapterNumber, draftId });
      }
    },
  );
}
