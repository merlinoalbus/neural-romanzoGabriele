import crypto from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { errorObj, toolError, toolStructured } from './responseHelpers.js';

/**
 * Cognitive-loop tools: the persistence layer that turns isolated scheduled runs into a
 * cumulative thinking process. Three capabilities:
 *
 * 1. Perception  — kg_recent_changes: what entered or changed in the graph since an instant.
 * 2. Curiosity   — open_question service nodes: questions a cognitive cycle leaves for the next
 *                  one (or for the next human editorial session).
 * 3. Metamemory  — self_assessment service nodes: what a cycle checked, found and proposed, so
 *                  the next run of the same process resumes instead of starting from scratch.
 *
 * open_question / self_assessment are SERVICE node types (like bible_coverage_finding): they are
 * never narrative canon and must never be treated as story facts.
 */

export const OPEN_QUESTION_TYPE = 'open_question';
export const SELF_ASSESSMENT_TYPE = 'self_assessment';
export const OPEN_QUESTION_STATUSES = ['open', 'investigating', 'resolved', 'dismissed'] as const;
export type OpenQuestionStatus = typeof OPEN_QUESTION_STATUSES[number];
export const OPEN_QUESTION_PRIORITIES = ['low', 'medium', 'high'] as const;

/** Deterministic label so re-logging the same question upserts instead of duplicating. */
export function openQuestionLabel(question: string): string {
  const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
  return `OQ-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`;
}

export function selfAssessmentLabel(process: string, runIso: string): string {
  return `${process.trim()}@${runIso}`;
}

const nodeZ = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const edgeZ = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.string(),
  weight: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

function metadataString(node: kg.GraphNode, key: string): string {
  const value = node.metadata[key];
  return typeof value === 'string' ? value : '';
}

export function registerCognitionTools(server: McpServer): void {
  server.registerTool(
    'kg_recent_changes',
    {
      title: 'KG recent changes',
      description:
        'Perception for the cognitive loop: returns nodes created/updated and edges created since an ISO-8601 instant. Read-only. Use it to scope event-driven digestion (process P4) to what actually changed instead of rescanning the whole graph.',
      inputSchema: {
        sinceIso: z.string().min(4),
        types: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeEdges: z.boolean().optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        since: z.string().optional(),
        createdNodes: z.array(nodeZ).optional(),
        updatedNodes: z.array(nodeZ).optional(),
        createdEdges: z.array(edgeZ).optional(),
        totals: z.object({ createdNodes: z.number(), updatedNodes: z.number(), createdEdges: z.number() }).optional(),
        truncated: z.boolean().optional(),
        error: errorObj,
      },
      annotations: { title: 'KG recent changes', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sinceIso, types, limit, includeEdges }) => {
      try {
        const result = await kg.recentChanges({ since: sinceIso, types, limit, includeEdges });
        return toolStructured({ ok: true, ...result });
      } catch (err) {
        return toolError('KG_RECENT_CHANGES_FAILED', `kg_recent_changes failed: ${String(err)}`, { sinceIso });
      }
    },
  );

  server.registerTool(
    'kg_log_open_question',
    {
      title: 'KG log open question',
      description:
        'Curiosity queue: records a narrative/structural question a cognitive cycle could not resolve, as a SERVICE node (type open_question, never canon). Idempotent per question text: re-logging the same question merges into the existing node. Optionally links the question to the graph nodes it is about.',
      inputSchema: {
        question: z.string().min(8),
        context: z.string().optional(),
        priority: z.enum(OPEN_QUESTION_PRIORITIES).optional(),
        sourceProcess: z.string().optional(),
        relatedNodeIds: z.array(z.string()).max(20).optional(),
      },
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), created: z.boolean().optional(), linkedNodeIds: z.array(z.string()).optional(), error: errorObj },
      annotations: { title: 'KG log open question', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ question, context, priority, sourceProcess, relatedNodeIds }) => {
      try {
        const label = openQuestionLabel(question);
        const { node, created } = await kg.upsertNode({
          type: OPEN_QUESTION_TYPE,
          label,
          content: question.trim(),
          metadata: {
            status: 'open',
            priority: priority ?? 'medium',
            sourceProcess: sourceProcess?.trim() || undefined,
            context: context?.trim() || undefined,
            canonStatus: 'service',
          },
          provenance: { source: 'kg_log_open_question', sourceProcess: sourceProcess?.trim() || undefined },
        });
        const linkedNodeIds: string[] = [];
        for (const relatedId of relatedNodeIds ?? []) {
          const related = await kg.getNodeById(relatedId);
          if (!related) continue;
          await kg.link({
            fromId: node.id,
            toId: related.id,
            kind: 'about',
            metadata: { canonStatus: 'service' },
            provenance: { source: 'kg_log_open_question' },
          });
          linkedNodeIds.push(related.id);
        }
        return toolStructured({ ok: true, node, created, linkedNodeIds });
      } catch (err) {
        return toolError('KG_LOG_OPEN_QUESTION_FAILED', `kg_log_open_question failed: ${String(err)}`, { question });
      }
    },
  );

  server.registerTool(
    'kg_update_open_question',
    {
      title: 'KG update open question',
      description: 'Moves an open question through its lifecycle (open → investigating → resolved/dismissed), optionally recording the resolution reasoning. Identify the question by id or by label.',
      inputSchema: {
        id: z.string().optional(),
        label: z.string().optional(),
        status: z.enum(OPEN_QUESTION_STATUSES),
        resolution: z.string().optional(),
        resolvedBy: z.string().optional(),
      },
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), error: errorObj },
      annotations: { title: 'KG update open question', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, label, status, resolution, resolvedBy }) => {
      try {
        const existing = id ? await kg.getNodeById(id) : label ? await kg.getNodeByTypeLabel(OPEN_QUESTION_TYPE, label) : null;
        if (!existing) return toolError('KG_UPDATE_OPEN_QUESTION_NOT_FOUND', 'Open question not found. Provide a valid id or label.', { id, label });
        if (existing.type !== OPEN_QUESTION_TYPE) {
          return toolError('KG_UPDATE_OPEN_QUESTION_WRONG_TYPE', `Node ${existing.id} has type '${existing.type}', not '${OPEN_QUESTION_TYPE}'.`, { id: existing.id });
        }
        const node = await kg.updateNode(existing.id, {
          metadata: {
            status,
            resolution: resolution?.trim() || undefined,
            resolvedBy: resolvedBy?.trim() || undefined,
            resolvedAt: status === 'resolved' || status === 'dismissed' ? new Date().toISOString() : undefined,
          },
          provenance: { source: 'kg_update_open_question' },
        });
        return toolStructured({ ok: true, node: node! });
      } catch (err) {
        return toolError('KG_UPDATE_OPEN_QUESTION_FAILED', `kg_update_open_question failed: ${String(err)}`, { id, label });
      }
    },
  );

  server.registerTool(
    'kg_list_open_questions',
    {
      title: 'KG list open questions',
      description: 'Reads the curiosity queue: open questions filtered by status (default: open + investigating) and optionally by sourceProcess. Read-only. Every cognitive cycle should start here.',
      inputSchema: {
        status: z.enum(OPEN_QUESTION_STATUSES).optional(),
        sourceProcess: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      outputSchema: { ok: z.boolean(), questions: z.array(nodeZ).optional(), counts: z.record(z.string(), z.number()).optional(), error: errorObj },
      annotations: { title: 'KG list open questions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, sourceProcess, limit }) => {
      try {
        const all = await kg.listNodesByType(OPEN_QUESTION_TYPE, { limit: 500 });
        const counts: Record<string, number> = {};
        for (const node of all) {
          const nodeStatus = metadataString(node, 'status') || 'open';
          counts[nodeStatus] = (counts[nodeStatus] ?? 0) + 1;
        }
        const wanted = status ? [status] : ['open', 'investigating'];
        let questions = all.filter((node) => wanted.includes(metadataString(node, 'status') || 'open'));
        if (sourceProcess?.trim()) questions = questions.filter((node) => metadataString(node, 'sourceProcess') === sourceProcess.trim());
        questions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        if (limit) questions = questions.slice(0, limit);
        return toolStructured({ ok: true, questions, counts });
      } catch (err) {
        return toolError('KG_LIST_OPEN_QUESTIONS_FAILED', `kg_list_open_questions failed: ${String(err)}`, {});
      }
    },
  );

  server.registerTool(
    'kg_log_self_assessment',
    {
      title: 'KG log self assessment',
      description:
        'Metamemory: records the outcome of a cognitive cycle (what was checked, found, proposed, what remains open) as a SERVICE node (type self_assessment, never canon). One node per run; the next run of the same process reads the latest one and resumes from there.',
      inputSchema: {
        process: z.string().min(2),
        summary: z.string().min(8),
        checked: z.array(z.string()).min(1).max(100),
        found: z.array(z.string()).max(100).optional(),
        proposals: z.array(z.string()).max(100).optional(),
        openQuestionIds: z.array(z.string()).max(50).optional(),
        stats: z.record(z.string(), z.unknown()).optional(),
      },
      outputSchema: { ok: z.boolean(), node: nodeZ.optional(), linkedQuestionIds: z.array(z.string()).optional(), error: errorObj },
      annotations: { title: 'KG log self assessment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ process, summary, checked, found, proposals, openQuestionIds, stats }) => {
      try {
        const runIso = new Date().toISOString();
        const node = await kg.addNode({
          type: SELF_ASSESSMENT_TYPE,
          label: selfAssessmentLabel(process, runIso),
          content: summary.trim(),
          metadata: {
            process: process.trim(),
            runAt: runIso,
            checked,
            found: found ?? [],
            proposals: proposals ?? [],
            stats: stats ?? undefined,
            canonStatus: 'service',
          },
          provenance: { source: 'kg_log_self_assessment', process: process.trim() },
        });
        const linkedQuestionIds: string[] = [];
        for (const questionId of openQuestionIds ?? []) {
          const question = await kg.getNodeById(questionId);
          if (!question || question.type !== OPEN_QUESTION_TYPE) continue;
          await kg.link({
            fromId: node.id,
            toId: question.id,
            kind: 'mentions',
            metadata: { canonStatus: 'service' },
            provenance: { source: 'kg_log_self_assessment' },
          });
          linkedQuestionIds.push(question.id);
        }
        return toolStructured({ ok: true, node, linkedQuestionIds });
      } catch (err) {
        return toolError('KG_LOG_SELF_ASSESSMENT_FAILED', `kg_log_self_assessment failed: ${String(err)}`, { process });
      }
    },
  );

  server.registerTool(
    'kg_get_latest_self_assessment',
    {
      title: 'KG get latest self assessment',
      description: 'Reads the metamemory: latest self_assessment (optionally per process) plus a short history. Read-only. Every scheduled cognitive cycle must call this first and resume from where the previous run stopped.',
      inputSchema: {
        process: z.string().optional(),
        historyLimit: z.number().int().positive().max(20).optional(),
      },
      outputSchema: { ok: z.boolean(), latest: nodeZ.nullable().optional(), history: z.array(nodeZ).optional(), error: errorObj },
      annotations: { title: 'KG get latest self assessment', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ process, historyLimit }) => {
      try {
        const all = await kg.listNodesByType(SELF_ASSESSMENT_TYPE, { limit: 500 });
        let assessments = process?.trim() ? all.filter((node) => metadataString(node, 'process') === process.trim()) : all;
        assessments = [...assessments].sort((a, b) => (metadataString(a, 'runAt') < metadataString(b, 'runAt') ? 1 : -1));
        const history = assessments.slice(0, historyLimit ?? 5);
        return toolStructured({ ok: true, latest: history[0] ?? null, history });
      } catch (err) {
        return toolError('KG_GET_LATEST_SELF_ASSESSMENT_FAILED', `kg_get_latest_self_assessment failed: ${String(err)}`, { process });
      }
    },
  );
}
