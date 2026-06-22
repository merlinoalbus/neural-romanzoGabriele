import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import {
  auditChapterContent,
  composeRecallQuery,
  DEFAULT_AUDIT_CHECKS,
  groupNarrativeContext,
  type AuditCheck,
} from '../novel/context.js';
import { normalizeChapterLabel } from '../novel/domain.js';
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

const edgeZ = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number(),
  metadata: jsonObj,
  provenance: jsonObj,
  createdAt: z.string(),
});

const contextGroupsZ = z.object({
  chapters: z.array(nodeZ),
  drafts: z.array(nodeZ),
  characters: z.array(nodeZ),
  characterVoices: z.array(nodeZ),
  relationshipDynamics: z.array(nodeZ),
  themes: z.array(nodeZ),
  locations: z.array(nodeZ),
  worldRules: z.array(nodeZ),
  styleRules: z.array(nodeZ),
  plotThreads: z.array(nodeZ),
  foreshadowing: z.array(nodeZ),
  glossaryTerms: z.array(nodeZ),
  timelineEvents: z.array(nodeZ),
  other: z.array(nodeZ),
});

const auditCheckZ = z.enum(['structure', 'characters', 'style', 'worldbuilding', 'themes', 'timeline']);

const findingZ = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  evidence: jsonObj.optional(),
});

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

export function registerNovelContextTools(server: McpServer): void {
  server.registerTool(
    'novel_recall_context',
    {
      title: 'Novel recall context',
      description: 'Read-only narrative recall grouped by chapters, characters, themes, world rules, style rules and related context.',
      inputSchema: {
        task: z.string(),
        chapterNumber: z.number().int().positive().optional(),
        query: z.string().optional(),
        characters: z.array(z.string()).optional(),
        includeDrafts: z.boolean().optional(),
        depth: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        query: z.string().optional(),
        matched: z.array(nodeZ).optional(),
        nodes: z.array(nodeZ).optional(),
        edges: z.array(edgeZ).optional(),
        context: contextGroupsZ.optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel recall context', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task, chapterNumber, query, characters, includeDrafts, depth, limit }) => {
      try {
        const recallQuery = composeRecallQuery({ task, chapterNumber, query, characters });
        if (!recallQuery) return toolStructured({ ok: true, query: '', matched: [], nodes: [], edges: [], context: groupNarrativeContext([]) });
        const recalled = await kg.recall(recallQuery, {
          depth: clampNumber(depth, 2, 1, 5),
          limit: clampNumber(limit, 12, 1, 100),
        });
        const context = groupNarrativeContext(recalled.nodes, { includeDrafts });
        return toolStructured({ ok: true, query: recallQuery, ...recalled, context });
      } catch (err) {
        return toolError('NOVEL_RECALL_CONTEXT_FAILED', `novel_recall_context failed: ${String(err)}`, { task, chapterNumber, query });
      }
    },
  );

  server.registerTool(
    'novel_audit_chapter',
    {
      title: 'Novel audit chapter',
      description: 'Read-only deterministic audit for available chapter context. It reports missing context and simple catalog matches; it does not certify prose quality.',
      inputSchema: {
        chapterNumber: z.number().int().positive(),
        content: z.string(),
        checks: z.array(auditCheckZ).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        readOnly: z.boolean().optional(),
        chapter: nodeZ.nullable().optional(),
        findings: z.array(findingZ).optional(),
        detectedCharacters: z.array(nodeZ).optional(),
        contextCounts: z.record(z.string(), z.number()).optional(),
        summary: z.object({
          findings: z.number(),
          errors: z.number(),
          warnings: z.number(),
          detectedCharacters: z.number(),
        }).optional(),
        error: errorObj,
      },
      annotations: { title: 'Novel audit chapter', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ chapterNumber, content, checks }) => {
      try {
        const normalizedChecks = (checks?.length ? checks : DEFAULT_AUDIT_CHECKS) as AuditCheck[];
        const [chapter, characters, styleRules, worldRules, themes, timelineEvents] = await Promise.all([
          kg.getNodeByTypeLabel('chapter', normalizeChapterLabel(chapterNumber)),
          kg.listNodesByType('character', { limit: 500 }),
          kg.listNodesByType('style_rule', { limit: 500 }),
          kg.listNodesByType('world_rule', { limit: 500 }),
          kg.listNodesByType('theme', { limit: 500 }),
          kg.listNodesByType('timeline_event', { limit: 500 }),
        ]);
        const audit = auditChapterContent({
          chapterNumber,
          content,
          checks: normalizedChecks,
          chapter,
          characters,
          styleRules,
          worldRules,
          themes,
          timelineEvents,
        });
        const errors = audit.findings.filter((finding) => finding.severity === 'error').length;
        const warnings = audit.findings.filter((finding) => finding.severity === 'warning').length;
        return toolStructured({
          ok: true,
          readOnly: true,
          chapter,
          findings: audit.findings,
          detectedCharacters: audit.detectedCharacters,
          contextCounts: {
            characters: characters.length,
            styleRules: styleRules.length,
            worldRules: worldRules.length,
            themes: themes.length,
            timelineEvents: timelineEvents.length,
          },
          summary: {
            findings: audit.findings.length,
            errors,
            warnings,
            detectedCharacters: audit.detectedCharacters.length,
          },
        });
      } catch (err) {
        return toolError('NOVEL_AUDIT_CHAPTER_FAILED', `novel_audit_chapter failed: ${String(err)}`, { chapterNumber });
      }
    },
  );
}
